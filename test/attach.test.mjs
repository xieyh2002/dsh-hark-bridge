/**
 * lib/attach.js 的测试
 *
 * 每个用例都用 mkdtempSync 建一个独立工作区：附件校验依赖真实文件系统
 * （realpath、stat、symlink、大小写），mock 掉 fs 等于把最需要验证的部分换成假的。
 * 临时目录放在 os.tmpdir() 下，避免中文路径的用例被项目目录自身的路径干扰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  AttachError,
  checkAttachment,
  collectAttachments,
  stageAttachments,
  cleanupStaging,
} from '../lib/attach.js';

/** 新建一个临时目录，用例结束时删掉（清理失败不该让用例红掉） */
function makeTemp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发被占用，忽略 */
    }
  });
  return dir;
}

/** 在 root 下写文件（自动建父目录），返回绝对路径 */
function writeFile(root, rel, content = 'hello') {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function workspace(t) {
  return makeTemp(t, 'hark-attach-');
}

function stageRoot(t) {
  return makeTemp(t, 'hark-stage-');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 断言抛出 AttachError，且 message 含全部关键字；返回该错误以便继续检查 */
function expectAttachError(fn, ...needles) {
  let error;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error, '期望抛出 AttachError，但函数正常返回了');
  assert.ok(error instanceof AttachError, `期望 AttachError，实际 ${error && error.constructor.name}`);
  assert.equal(error.name, 'HarkAttachError', 'name 必须是 HarkAttachError，便于调用方识别');
  for (const needle of needles) {
    assert.ok(
      String(error.message).includes(needle),
      `报错应包含「${needle}」，实际：${error.message}`,
    );
  }
  return error;
}

// ---------------------------------------------------------------- 单文件校验

test('checkAttachment：正常文件返回 rel/abs/bytes/sha256', (t) => {
  const ws = workspace(t);
  const body = 'export const answer = 42;\n';
  writeFile(ws, 'src/deep/a.js', body);

  const item = checkAttachment('src/deep/a.js', { workspaceRoot: ws });

  // rel 必须是 POSIX 分隔符：它会直接进上传名和清单，带反斜杠在 Hark 侧会显示成怪名字
  assert.equal(item.rel, 'src/deep/a.js');
  assert.ok(!item.rel.includes('\\'), 'rel 不应含反斜杠');
  assert.ok(path.isAbsolute(item.abs), 'abs 必须是绝对路径');
  assert.equal(item.abs, fs.realpathSync(path.join(ws, 'src', 'deep', 'a.js')));
  assert.equal(item.bytes, Buffer.byteLength(body));
  assert.match(item.sha256, /^[0-9a-f]{64}$/, 'sha256 应是 64 位小写 hex');
  assert.equal(item.sha256, sha256(body));
});

test('checkAttachment：绝对路径与相对路径解析到同一项', (t) => {
  const ws = workspace(t);
  const abs = writeFile(ws, 'a/b.md', '# hi');

  const byRel = checkAttachment('a/b.md', { workspaceRoot: ws });
  const byAbs = checkAttachment(abs, { workspaceRoot: ws });

  assert.deepEqual(byAbs, byRel);
  assert.equal(byAbs.rel, 'a/b.md');
});

test('checkAttachment：工作区外的绝对路径被拒绝', (t) => {
  const ws = workspace(t);
  const other = makeTemp(t, 'hark-attach-outside-');
  const outside = writeFile(other, 'secret.txt', 'nope');

  expectAttachError(() => checkAttachment(outside, { workspaceRoot: ws }), '工作区');
});

test('checkAttachment：边界绕过 —— 同前缀的 ws-other 不算工作区内', (t) => {
  const base = workspace(t);
  // 构造前缀相同的两个目录：ws 与 ws-other。
  // 只用 startsWith 的实现会把 ws-other 当成 ws 的子目录，放行工作区外的文件。
  const ws = path.join(base, 'ws');
  const sibling = path.join(base, 'ws-other');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  const target = path.join(sibling, 'f.txt');
  fs.writeFileSync(target, 'outside');

  expectAttachError(() => checkAttachment(target, { workspaceRoot: ws }), '工作区');

  // 对照：ws 自己的同名文件必须能过，证明拒绝不是因为别的规则
  writeFile(ws, 'f.txt', 'inside');
  assert.equal(checkAttachment('f.txt', { workspaceRoot: ws }).rel, 'f.txt');
});

test('checkAttachment：不存在的文件报「不存在」', (t) => {
  const ws = workspace(t);
  expectAttachError(() => checkAttachment('src/nope.js', { workspaceRoot: ws }), '文件不存在');
});

test('checkAttachment：目录报「不是普通文件」', (t) => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws, 'src'));
  expectAttachError(() => checkAttachment('src', { workspaceRoot: ws }), '不是普通文件');
});

test('checkAttachment：超过单文件上限时带出具体字节数', (t) => {
  const ws = workspace(t);
  writeFile(ws, 'big.bin', Buffer.alloc(100, 0x61));

  expectAttachError(
    () => checkAttachment('big.bin', { workspaceRoot: ws, maxFileBytes: 50 }),
    '超过单文件上限',
    '100',
    '50',
  );
});

test('checkAttachment：空字符串与非字符串先报类型', (t) => {
  const ws = workspace(t);
  for (const bad of ['', '   ', undefined, null, 42, {}]) {
    expectAttachError(() => checkAttachment(bad, { workspaceRoot: ws }), '路径必须是字符串');
  }
});

test('checkAttachment：敏感文件逐条命中且报出具体规则名', (t) => {
  const ws = workspace(t);
  const cases = [
    ['.env', '环境变量文件'],
    ['.env.local', '环境变量文件'],
    ['settings.json', '插件设置文件'],
    ['keys/id_rsa', '私钥'],
    ['cert/a.pem', '私钥或证书文件'],
    ['.git/config', 'git 内部文件'],
    ['node_modules/x/y.js', '依赖目录'],
  ];
  for (const [rel, ruleName] of cases) {
    writeFile(ws, rel, 'secret');
    const err = expectAttachError(
      () => checkAttachment(rel, { workspaceRoot: ws }),
      '命中敏感文件规则',
      rel.includes('\\') ? rel : rel.split('/').join('/'),
    );
    assert.ok(
      err.message.includes(ruleName),
      `${rel} 的报错应含规则名「${ruleName}」，实际：${err.message}`,
    );
  }
});

test('checkAttachment：符号链接指向工作区外时拒绝', (t) => {
  const ws = workspace(t);
  const outside = makeTemp(t, 'hark-attach-linked-');
  const real = writeFile(outside, 'real.txt', 'secret');
  const link = path.join(ws, 'link.txt');

  try {
    fs.symlinkSync(real, link, 'file');
  } catch (err) {
    // Windows 建 symlink 需要管理员或开发者模式，跳过而不是让整个测试集红掉
    if (process.platform === 'win32') {
      t.skip(`Windows 无创建 symlink 的权限：${err.code}`);
      return;
    }
    throw err;
  }

  // 词法上 link.txt 就在工作区里，只有 realpath 之后才能看出目标在外面
  expectAttachError(() => checkAttachment('link.txt', { workspaceRoot: ws }), '工作区');
});

// ---------------------------------------------------------------- 批量校验

test('collectAttachments：三个正常文件', (t) => {
  const ws = workspace(t);
  writeFile(ws, 'a.js', 'aaaa');
  writeFile(ws, 'dir/b.md', 'bbbbbb');
  writeFile(ws, '我的 文档.md', '中文内容');

  const result = collectAttachments(['a.js', 'dir/b.md', '我的 文档.md'], { workspaceRoot: ws });

  assert.equal(result.items.length, 3);
  assert.equal(result.skipped.length, 0);
  assert.equal(
    result.totalBytes,
    Buffer.byteLength('aaaa') + Buffer.byteLength('bbbbbb') + Buffer.byteLength('中文内容'),
  );
  assert.equal(result.totalBytes, result.items.reduce((sum, i) => sum + i.bytes, 0));
});

test('collectAttachments：坏路径进 skipped，好路径仍在 items', (t) => {
  const ws = workspace(t);
  writeFile(ws, 'ok.js', 'ok');
  writeFile(ws, '.env', 'SECRET=1');

  const result = collectAttachments(['ok.js', 'missing.js', '.env'], { workspaceRoot: ws });

  assert.equal(result.items.length, 1, '只有一个文件能通过');
  assert.equal(result.items[0].rel, 'ok.js');
  assert.equal(result.skipped.length, 2);
  const missing = result.skipped.find((s) => s.path === 'missing.js');
  assert.ok(missing && missing.reason.includes('不存在'), '不存在的路径要说明原因');
  const denied = result.skipped.find((s) => s.path === '.env');
  assert.ok(denied && denied.reason.includes('环境变量文件'), '被规则拦下的要写明规则名');
});

test('collectAttachments：全部失败时抛错并汇总原因', (t) => {
  const ws = workspace(t);
  expectAttachError(
    () => collectAttachments(['a.js', 'b.js'], { workspaceRoot: ws }),
    '全部被拒绝',
    'a.js',
    'b.js',
    '不存在',
  );
});

test('collectAttachments：同一文件传两次只留一份', (t) => {
  const ws = workspace(t);
  const abs = writeFile(ws, 'src/a.js', 'x');

  const result = collectAttachments(['src/a.js', abs], { workspaceRoot: ws });

  assert.equal(result.items.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped[0].reason.includes('重复'), result.skipped[0].reason);
  assert.equal(result.totalBytes, 1);
});

test('collectAttachments：超过 maxFiles 的项进 skipped', (t) => {
  const ws = workspace(t);
  const paths = [];
  for (let i = 0; i < 21; i += 1) {
    const rel = `f${String(i).padStart(2, '0')}.txt`;
    writeFile(ws, rel, 'x');
    paths.push(rel);
  }

  const result = collectAttachments(paths, { workspaceRoot: ws, maxFiles: 20 });

  assert.equal(result.items.length, 20);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].path, 'f20.txt', '最后一个应被拦下');
  assert.ok(result.skipped[0].reason.includes('20'), result.skipped[0].reason);
});

test('collectAttachments：超过 maxTotalBytes 的项带具体数字进 skipped', (t) => {
  const ws = workspace(t);
  writeFile(ws, 'a.txt', 'aaaa'); // 4 字节
  writeFile(ws, 'b.txt', 'bbbb'); // 4 字节

  const result = collectAttachments(['a.txt', 'b.txt'], { workspaceRoot: ws, maxTotalBytes: 6 });

  assert.equal(result.items.length, 1);
  assert.equal(result.totalBytes, 4);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /4|6|总量/);
});

test('collectAttachments：空数组返回空结果，不抛错', (t) => {
  const ws = workspace(t);
  const result = collectAttachments([], { workspaceRoot: ws });
  assert.deepEqual(result, { items: [], totalBytes: 0, skipped: [] });
});

// ---------------------------------------------------------------- 暂存

test('stageAttachments：扁平化目录并保持内容一致', (t) => {
  const ws = workspace(t);
  const stage = stageRoot(t);
  const body = 'export default function bridge() {}\n';
  writeFile(ws, 'lib/bridge.js', body);

  const items = collectAttachments(['lib/bridge.js'], { workspaceRoot: ws }).items;
  const staged = stageAttachments(items, path.join(stage, 'nested'));

  assert.equal(staged.length, 1);
  assert.equal(staged[0].uploadName, 'lib__bridge.js');
  assert.equal(staged[0].staged, path.join(stage, 'nested', 'lib__bridge.js'));
  assert.ok(fs.existsSync(staged[0].staged), '暂存目录不存在时应自动创建');
  assert.equal(fs.readFileSync(staged[0].staged, 'utf8'), body);
  assert.equal(staged[0].sha256, sha256(body));
  // 原有字段不能被覆盖：调用方还要拿 rel/bytes 拼清单
  assert.equal(staged[0].rel, 'lib/bridge.js');
  assert.equal(staged[0].bytes, Buffer.byteLength(body));
});

test('stageAttachments：不同目录同名文件不冲突，字面撞名才加 -2', (t) => {
  const ws = workspace(t);
  const stage = stageRoot(t);
  writeFile(ws, 'a/x.md', 'A');
  writeFile(ws, 'b/x.md', 'B');
  // 这个文件名本身把 `__` 当普通字符用，扁平化后正好与 a/x.md 撞上，才需要加后缀
  writeFile(ws, 'a__x.md', 'C');

  const items = collectAttachments(['a/x.md', 'b/x.md', 'a__x.md'], { workspaceRoot: ws }).items;
  const staged = stageAttachments(items, stage);
  const names = staged.map((s) => s.uploadName);

  assert.deepEqual(names, ['a__x.md', 'b__x.md', 'a__x-2.md']);
  assert.ok(names[2].endsWith('.md'), '后缀必须加在扩展名之前');
  assert.equal(fs.readFileSync(staged[2].staged, 'utf8'), 'C');
  assert.equal(fs.readFileSync(staged[0].staged, 'utf8'), 'A');
});

test('stageAttachments：中文与空格文件名原样保留', (t) => {
  const ws = workspace(t);
  const stage = stageRoot(t);
  writeFile(ws, '文档/设计 说明.md', '# 中文');

  const items = collectAttachments(['文档/设计 说明.md'], { workspaceRoot: ws }).items;
  const staged = stageAttachments(items, stage);

  assert.equal(staged[0].uploadName, '文档__设计 说明.md');
  assert.ok(fs.existsSync(staged[0].staged));
});

test('stageAttachments：Windows 保留字符换成下划线', (t) => {
  // 这些字符在 POSIX 上可以出现在文件名里，传到 Windows 侧会变成非法名，
  // 所以在 uploadName 上净化；用合成 item 是因为源文件不一定能在 Windows 上创建出来。
  const stage = stageRoot(t);
  const abs = writeFile(stage, 'src.txt', 'x');
  const items = [{ rel: 'dir/a?b*c|d.txt', abs, bytes: 1, sha256: sha256('x') }];

  const staged = stageAttachments(items, path.join(stage, 'out'));
  assert.equal(staged[0].uploadName, 'dir__a_b_c_d.txt');
});

test('stageAttachments：sha256 与源不一致时报错', (t) => {
  const ws = workspace(t);
  const stage = stageRoot(t);
  writeFile(ws, 'a.txt', 'real');

  const items = collectAttachments(['a.txt'], { workspaceRoot: ws }).items;
  // 篡改期望值，模拟「内容在复制那一瞬间被别的进程换掉」
  items[0].sha256 = sha256('different');

  expectAttachError(() => stageAttachments(items, stage), 'sha256');
});

test('stageAttachments：空列表直接返回空数组，不建目录', () => {
  const stage = path.join(os.tmpdir(), `hark-stage-none-${process.pid}-${Date.now()}`);
  assert.deepEqual(stageAttachments([], stage), []);
  assert.equal(fs.existsSync(stage), false);
});

// ---------------------------------------------------------------- 清理

test('cleanupStaging：删除整个目录，且对不存在的目录不抛错', (t) => {
  const stage = stageRoot(t);
  writeFile(stage, 'a.txt', 'x');
  writeFile(stage, 'sub/b.txt', 'y');

  cleanupStaging(stage);
  assert.equal(fs.existsSync(stage), false);

  // 再调一次（目录已不存在）不能抛错：调用方一般把它放 finally 里
  assert.doesNotThrow(() => cleanupStaging(stage));
  assert.doesNotThrow(() => cleanupStaging(path.join(stage, 'never', 'existed')));
  assert.doesNotThrow(() => cleanupStaging(''));
});
