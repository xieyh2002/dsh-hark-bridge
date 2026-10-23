/**
 * lib/reply-store.js 的回归测试
 *
 * 这一层的价值全在「边界不出错」上：文件名撞车、路径越界、编码、空回复。
 * 所以每个用例都开自己的临时工作区，互不影响，也不碰用户真实目录。
 * 用 node:test（Node 20 自带），不引任何依赖。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReplyStoreError, renameDownloaded, resolveReplyDir, saveReply } from '../lib/reply-store.js';

/** 每个用例一个干净的临时工作区，register 到 after 里统一清理 */
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hark-reply-'));
  t.after(() => {
    // Windows 上只读属性会挡住删除，先尽力恢复再删
    try { chmodSync(root, 0o777); } catch { /* 尽力而为 */ }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** 用例固定的时间点，避免跨秒导致文件名不稳定 */
const NOW = new Date(2026, 9, 22, 20, 49, 31); // 2026-10-22 20:49:31 本地时间

/** 读 front matter 与正文，顺便验证分隔结构 */
function parse(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  assert.equal(lines[0], '---', '文件必须以 front matter 开头');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'front matter 必须有结束的 ---');
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  // front matter 之后应有且仅有一个空行
  assert.equal(lines[end + 1], '', 'front matter 后要空一行');
  return { fields, body: lines.slice(end + 2).join('\n'), text };
}

// ---- 1. 默认目录 ----
test('resolveReplyDir 默认给出 <root>/.hark/replies', (t) => {
  const root = workspace(t);
  assert.equal(resolveReplyDir({ workspaceRoot: root }), join(root, '.hark', 'replies'));
  // replyDir 给空白也算没给
  assert.equal(resolveReplyDir({ workspaceRoot: root, replyDir: '   ' }), join(root, '.hark', 'replies'));
});

// ---- 2. 相对 replyDir ----
test('resolveReplyDir 相对路径按 workspaceRoot 解析', (t) => {
  const root = workspace(t);
  assert.equal(resolveReplyDir({ workspaceRoot: root, replyDir: 'notes' }), join(root, 'notes'));
  assert.equal(resolveReplyDir({ workspaceRoot: root, replyDir: './a/b' }), join(root, 'a', 'b'));
  // 回到工作区内的 .. 仍算之内
  assert.equal(resolveReplyDir({ workspaceRoot: root, replyDir: 'notes/../out' }), join(root, 'out'));
});

// ---- 3. 绝对路径在工作区内 ----
test('resolveReplyDir 接受工作区内的绝对路径', (t) => {
  const root = workspace(t);
  const abs = join(root, 'replies');
  assert.equal(resolveReplyDir({ workspaceRoot: root, replyDir: abs }), abs);
  assert.equal(resolveReplyDir({ workspaceRoot: root, replyDir: root }), root);
});

// ---- 4. 绝对路径越界 ----
test('resolveReplyDir 拒绝工作区外的路径', (t) => {
  const root = workspace(t);
  const outside = join(root, '..', 'somewhere-else');
  assert.throws(() => resolveReplyDir({ workspaceRoot: root, replyDir: outside }), (err) => {
    assert.ok(err instanceof ReplyStoreError, '必须是 ReplyStoreError');
    assert.equal(err.name, 'HarkReplyStoreError');
    return true;
  });
  // 相对路径一路 .. 出去也一样
  assert.throws(() => resolveReplyDir({ workspaceRoot: root, replyDir: '../escape' }), ReplyStoreError);
  // 前缀相同但不是父子关系（workspace 的兄弟目录）不能误判为之内
  const sibling = `${root}-sibling`;
  assert.throws(() => resolveReplyDir({ workspaceRoot: root, replyDir: sibling }), ReplyStoreError);
});

// ---- 5. 目录自动创建 ----
test('saveReply 自动建目录并写出可读的 front matter', (t) => {
  const root = workspace(t);
  const dir = resolveReplyDir({ workspaceRoot: root });
  assert.equal(existsSync(dir), false, '前置条件：目录还不存在');

  const out = saveReply({ dir, id: 'xxx', mode: 'plan', reply: '正文内容', now: NOW });
  assert.ok(existsSync(out.abs), '文件要真的存在');
  assert.equal(existsSync(dir), true, '目录要被自动创建');

  const { fields, body } = parse(out.abs);
  assert.equal(fields.id, 'xxx');
  assert.equal(fields.mode, 'plan');
  assert.equal(body, '正文内容\n');
  assert.ok(readFileSync(out.abs, 'utf8').includes('---\nid: xxx'), '内容里要能直接 grep 到 id');
});

// ---- 6. 文件名格式 ----
test('文件名形如 <YYYYMMDD-HHmmss>-<mode>-<id>.md', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  const out = saveReply({ dir, id: 'abc123', mode: 'plan', reply: 'x', now: NOW });
  assert.match(out.rel, /^\d{8}-\d{6}-plan-abc123\.md$/);
  assert.equal(out.rel, '20261022-204931-plan-abc123.md');
  assert.equal(out.abs, join(dir, out.rel));
  assert.equal(out.rel.includes('\\'), false, 'rel 必须是 POSIX 风格，不能带反斜杠');
});

// ---- 6b. 有标题时文件名用标题，不再是一串编号 ----
test('正文有一级标题时，文件名用标题而不是请求编号', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  const out = saveReply({
    dir, id: 'abc123', mode: 'plan', now: NOW,
    reply: '# 附件卡片只认本次回复\n\n- 下界改成结束标记\n',
  });
  assert.equal(out.rel, '20261022-204931-plan-附件卡片只认本次回复.md');
});

test('标题里的 Markdown 符号和文件名非法字符都清掉', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  const out = saveReply({
    dir, id: 'x', mode: 'review', now: NOW,
    reply: '## 复审：`bridge.js` / **锁** 的问题？\n\n正文\n',
  });
  // 冒号、斜杠、反引号、星号都不能留在文件名里；中文和问号可以留（Windows 允许）
  assert.equal(out.rel.includes(':'), false, `不能有冒号：${out.rel}`);
  assert.equal(out.rel.includes('/'), false, `不能有斜杠：${out.rel}`);
  assert.equal(out.rel.includes('`'), false, `不能有反引号：${out.rel}`);
  assert.equal(out.rel.includes('*'), false, `不能有星号：${out.rel}`);
  assert.ok(out.rel.includes('复审'), `标题主体要留住：${out.rel}`);
});

test('没有标题时退回请求编号（保持旧行为）', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  const out = saveReply({ dir, id: 'abc123', mode: 'chat', reply: '收到，我看一下。\n', now: NOW });
  assert.equal(out.rel, '20261022-204931-chat-abc123.md');
});

test('超长标题截断到 60 字符，不会撞上文件名长度上限', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  const long = '一'.repeat(200);
  const out = saveReply({ dir, id: 'x', mode: 'plan', reply: `# ${long}\n`, now: NOW });
  const stem = out.rel.replace(/^\d{8}-\d{6}-plan-/, '').replace(/\.md$/, '');
  assert.equal(stem.length, 60, `标题部分应截到 60：${stem.length}`);
});

// ---- 6c. 下载回来的附件改名 ----
test('renameDownloaded 用卡片名，产出可读文件名', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'g9g6f88rq.hark.md');
  writeFileSync(tmp, '# 改进方案\n\n正文\n', 'utf8');

  const out = renameDownloaded({ saved: tmp, name: 'dsh-hark-bridge-0.8-改进方案.md', mode: 'plan', now: NOW });
  assert.equal(out.name, '20261022-204931-plan-dsh-hark-bridge-0.8-改进方案.md');
  assert.equal(out.saved, join(dir, out.name));
  assert.equal(existsSync(tmp), false, '旧名不该留下');
  assert.ok(existsSync(out.saved));
});

test('renameDownloaded 拿不到卡片名时退回正文标题', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'x.hark.md');
  writeFileSync(tmp, '# 仓库审查意见\n\n- 阻断 1\n', 'utf8');
  const out = renameDownloaded({ saved: tmp, name: '', mode: 'review', now: NOW });
  assert.equal(out.name, '20261022-204931-review-仓库审查意见.md');
});

test('renameDownloaded 撞名时加序号，不覆盖已有文件', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  mkdirSync(dir, { recursive: true });
  const first = join(dir, 'a.hark.md');
  writeFileSync(first, '# 方案\n', 'utf8');
  const one = renameDownloaded({ saved: first, name: '方案.md', mode: 'plan', now: NOW });
  assert.equal(one.name, '20261022-204931-plan-方案.md');

  const second = join(dir, 'b.hark.md');
  writeFileSync(second, '# 方案\n', 'utf8');
  const two = renameDownloaded({ saved: second, name: '方案.md', mode: 'plan', now: NOW });
  assert.equal(two.name, '20261022-204931-plan-方案-2.md', '第二个要加 -2，不能覆盖');
  assert.equal(existsSync(one.saved), true, '第一个必须还在');
});

test('renameDownloaded 没有可用名字时原样返回，不丢文件', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'keep.hark.md');
  writeFileSync(tmp, '没有标题的纯文本\n', 'utf8');
  const out = renameDownloaded({ saved: tmp, name: '', mode: 'chat', now: NOW });
  assert.equal(out.saved, tmp, '算不出名字就不动它');
  assert.ok(existsSync(tmp));
});

// ---- 7. savedAt 与 meta ----
test('front matter 带可解析的 savedAt 和 meta 字段', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  const out = saveReply({
    dir,
    id: 'j5y4sxaye',
    mode: 'review',
    reply: '看完了\n',
    now: NOW,
    meta: { harkUrl: 'https://hark.com/project/xxx', attachments: ['a.md', 'b.js'], source: 'innertext' },
  });
  const { fields } = parse(out.abs);

  assert.ok(fields.savedAt, 'savedAt 不能缺');
  const parsed = new Date(fields.savedAt);
  assert.equal(Number.isNaN(parsed.getTime()), false, `savedAt 要能被 Date 解析：${fields.savedAt}`);
  assert.equal(parsed.getTime(), NOW.getTime(), 'savedAt 必须就是传入的 now');
  // 本地时区 ISO：要么 Z，要么 ±HH:MM
  assert.match(fields.savedAt, /(?:Z|[+-]\d{2}:\d{2})$/, 'savedAt 要带时区信息');

  // 含冒号的 URL 要用双引号包住，否则 YAML 会把它当嵌套映射
  assert.match(readFileSync(out.abs, 'utf8'), /harkUrl: "https:\/\/hark\.com\/project\/xxx"/);
  assert.equal(fields.harkUrl, 'https://hark.com/project/xxx');
  assert.equal(fields.attachments, 'a.md, b.js', '数组用逗号加空格连接');
  assert.equal(fields.source, 'innertext');

  // 固定顺序：id、mode 在前，savedAt 收尾
  const keys = Object.keys(fields);
  assert.deepEqual(keys, ['id', 'mode', 'harkUrl', 'attachments', 'source', 'savedAt']);
});

// ---- 8. 同名不覆盖 ----
test('同 id 同秒重复保存时追加 -2 后缀，不覆盖旧文件', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  const first = saveReply({ dir, id: 'dup', mode: 'plan', reply: '第一次', now: NOW });
  const second = saveReply({ dir, id: 'dup', mode: 'plan', reply: '第二次', now: NOW });

  assert.equal(first.rel, '20261022-204931-plan-dup.md');
  assert.equal(second.rel, '20261022-204931-plan-dup-2.md', '第二个要带 -2');
  assert.notEqual(first.abs, second.abs);
  assert.ok(existsSync(first.abs) && existsSync(second.abs), '两个文件都要在');

  const a = parse(first.abs).body;
  const b = parse(second.abs).body;
  assert.equal(a, '第一次\n', '第一个文件的内容不能被后来的覆盖');
  assert.equal(b, '第二次\n');
  assert.notEqual(a, b);

  const third = saveReply({ dir, id: 'dup', mode: 'plan', reply: '第三次', now: NOW });
  assert.equal(third.rel, '20261022-204931-plan-dup-3.md', '第三个继续往后排');
});

// ---- 9. 多个 id 连写 ----
test('连续保存 10 条不同回复，10 个文件都在', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  const ids = Array.from({ length: 10 }, (_, i) => `id${i}`);
  const results = [];
  // saveReply 是同步的，for 循环按顺序落盘；用 Promise.all 包同步函数没有并发意义
  for (const [i, id] of ids.entries()) {
    results.push(saveReply({ dir, id, mode: 'chat', reply: `第 ${i} 条`, now: NOW }));
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 10, '10 条回复应该正好 10 个文件');
  assert.equal(new Set(results.map((r) => r.abs)).size, 10, '路径不能重复');
  for (const r of results) assert.ok(existsSync(r.abs));
  assert.deepEqual([...files].sort(), results.map((r) => r.rel).sort());
});

// ---- 10. 正文原样 ----
test('正文里的分隔线、代码围栏、中文都原样保留', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  const reply = [
    '## 结论',
    '',
    '---',
    '',
    '```js',
    'const a = "---";// 注释里的 --- 不能被当成 front matter 结束',
    '```',
    '',
    '中文段落：这里有个 emoji 😀 和 tab\t。',
  ].join('\n');

  const out = saveReply({ dir, id: 'raw', mode: 'review', reply, now: NOW });
  const { body } = parse(out.abs);
  assert.equal(body, `${reply}\n`, '正文必须逐字节原样，只在末尾补一个换行');
});

// ---- 11. 空回复 ----
test('空回复也生成文件（只有 front matter 和空正文）', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  const out = saveReply({ dir, id: 'empty', mode: 'chat', reply: '', now: NOW });
  assert.ok(existsSync(out.abs));
  const { fields, body } = parse(out.abs);
  assert.equal(fields.id, 'empty');
  assert.equal(body.trim(), '', '正文应为空');
  assert.ok(readFileSync(out.abs, 'utf8').startsWith('---\nid: empty\n'));
});

// ---- 12. 写盘失败 ----
test('写盘失败时抛 ReplyStoreError', (t) => {
  const root = workspace(t);

  // 确定性场景：期望的「目录」位置上是个普通文件，mkdirSync 必然 ENOTDIR/EEXIST。
  // 这条比 chmod 可靠得多——Windows 的 chmod 只改只读属性，目录照样能写入。
  const blocker = join(root, 'blocker');
  writeFileSync(blocker, 'not a dir', 'utf8');
  assert.throws(
    () => saveReply({ dir: join(blocker, 'sub'), id: 'x', mode: 'plan', reply: 'y', now: NOW }),
    (err) => {
      assert.ok(err instanceof ReplyStoreError, '必须包成 ReplyStoreError');
      assert.equal(err.name, 'HarkReplyStoreError');
      assert.ok(err.cause, '要保留原始错误，方便排查');
      return true;
    },
  );

  // chmod 场景：POSIX 上有效，Windows 上多半仍是可写——不可写就断言，能写就跳过。
  const roDir = join(root, 'readonly');
  mkdirSync(roDir);
  try {
    chmodSync(roDir, 0o444);
    let wrote = true;
    try {
      saveReply({ dir: roDir, id: 'x', mode: 'plan', reply: 'y', now: NOW });
    } catch (err) {
      wrote = false;
      assert.ok(err instanceof ReplyStoreError, '只读目录失败也要是 ReplyStoreError');
      assert.equal(existsSync(join(roDir, '20261022-204931-plan-x.md')), false, '失败时不能留下目标文件');
      // 临时文件走 rename，失败后也要清掉，不留垃圾
      assert.deepEqual(readdirSync(roDir).filter((f) => f.includes('.tmp')), [], '不能留下 tmp 文件');
    }
    if (wrote) t.diagnostic('chmod 0o444 在当前平台未生效（Windows 常见），跳过只读断言');
  } catch (err) {
    // chmod 本身不支持（某些文件系统/权限），整段跳过
    t.diagnostic(`chmod 不可用，跳过只读断言：${err && err.message}`);
  } finally {
    try { chmodSync(roDir, 0o777); } catch { /* 尽力恢复，否则临时目录删不掉 */ }
  }
});

// ---- 13. 中文路径 ----
test('中文工作区与中文 replyDir 都能正常写入', (t) => {
  const root = workspace(t);
  const dir = join(root, '中文 目录');
  const out = saveReply({
    dir,
    id: '中文id',
    mode: 'plan',
    reply: '中文回复：结论是同意的。',
    now: NOW,
    meta: { source: '中文来源' },
  });
  assert.ok(existsSync(out.abs));
  assert.ok(out.abs.startsWith(join(root, '中文 目录')), '文件要落在中文目录里');
  const { fields, body } = parse(out.abs);
  assert.equal(fields.id, '中文id');
  assert.equal(body, '中文回复：结论是同意的。\n');
  // resolveReplyDir 也认中文相对路径
  assert.equal(resolveReplyDir({ workspaceRoot: root, replyDir: '中文 目录' }), dir);
});

// ---- 14. 参数校验（额外） ----
test('缺少 dir/id/mode 时给出明确的 ReplyStoreError', (t) => {
  const root = workspace(t);
  const dir = join(root, 'r');
  assert.throws(() => saveReply({ id: 'a', mode: 'plan', reply: '' }), ReplyStoreError);
  assert.throws(() => saveReply({ dir, mode: 'plan', reply: '' }), ReplyStoreError);
  assert.throws(() => saveReply({ dir, id: 'a', reply: '' }), ReplyStoreError);
  assert.throws(() => resolveReplyDir({}), ReplyStoreError);
  // meta 里的空值跳过，不能写出 "key: " 这种半截行
  const out = saveReply({
    dir, id: 'a', mode: 'plan', reply: 'x', now: NOW,
    meta: { empty: '', nil: null, undef: undefined, blankArr: [], keep: 'v' },
  });
  const keys = Object.keys(parse(out.abs).fields);
  assert.deepEqual(keys, ['id', 'mode', 'keep', 'savedAt']);
});
