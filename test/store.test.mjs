/**
 * 配置覆盖层测试：全局层 / 工作区层的优先级与降级。
 *
 * 为什么要两层：插件走原生 fs，不受 dsh-fs-sandbox 约束，但部署方可能真的只给
 * 会话工作区写权限。那种环境下写 %LOCALAPPDATA% 会失败，插件就彻底没法配置。
 * 所以默认写全局，写不进去自动落到 <工作区>/.hark/settings.json。
 *
 * 这个文件覆盖四种组合：只有全局、只有工作区、两层都有（工作区优先）、
 * 全局不可写（自动降级）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-store-'));
const globalHome = path.join(sandbox, 'global');
const workspace = path.join(sandbox, 'ws');
fs.mkdirSync(workspace, { recursive: true });

// 必须在 import store 之前设好：模块顶层不会读目录，但 dataDir() 每次都读环境变量，
// 所以这里设了就够了；仍然先设，避免任何早读。
process.env.DSH_HARK_BRIDGE_HOME = globalHome;

const {
  dataDir, readOverride, setWorkspaceRoot, storePath, workspaceDataDir, writeOverride, normalizeUrl,
} = await import('../lib/store.js');

const globalFile = path.join(globalHome, 'settings.json');
const wsFile = path.join(workspace, '.hark', 'settings.json');

// --- 1. 没有工作区时，只读写全局层 ---
{
  setWorkspaceRoot('');
  assert.equal(dataDir(), path.resolve(globalHome), 'dataDir 应指向 DSH_HARK_BRIDGE_HOME');
  assert.equal(workspaceDataDir(), '', '没有工作区就没有工作区层');
  assert.deepEqual(readOverride(), {}, '初始应为空');

  writeOverride({ harkUrl: 'https://global.example.com/p/1' });
  assert.ok(fs.existsSync(globalFile), '默认写全局层');
  assert.equal(readOverride().harkUrl, 'https://global.example.com/p/1');
  assert.equal(storePath(), globalFile, '只存在全局层时，提示路径应是它');
}

// --- 2. 有工作区但工作区层不存在：读到的仍是全局值 ---
{
  setWorkspaceRoot(workspace);
  assert.equal(workspaceDataDir(), path.join(workspace, '.hark'));
  assert.equal(readOverride().harkUrl, 'https://global.example.com/p/1', '工作区层没值时应回落到全局');
  assert.equal(storePath(), globalFile, '工作区层不存在时，提示路径仍是全局文件');
}

// --- 3. 工作区层有同名键：覆盖全局 ---
{
  fs.mkdirSync(path.dirname(wsFile), { recursive: true });
  fs.writeFileSync(wsFile, JSON.stringify({ harkUrl: 'https://ws.example.com/p/2' }), 'utf8');
  assert.equal(readOverride().harkUrl, 'https://ws.example.com/p/2', '工作区层优先');
  assert.equal(storePath(), wsFile, '工作区层存在时，提示路径应是它');
}

// --- 4. 工作区层用 null 占位可以删掉全局键 ---
{
  fs.writeFileSync(wsFile, JSON.stringify({ harkUrl: null }), 'utf8');
  assert.equal('harkUrl' in readOverride(), false, 'null 表示「这一层要求删掉全局同名键」');
}

// --- 5. 全局层可写时，写入落在全局（默认行为不变） ---
{
  fs.rmSync(wsFile, { force: true });
  writeOverride({ harkUrl: 'https://after-delete.example.com/p/3' });
  assert.ok(fs.existsSync(globalFile), '全局可写就该写全局');
  assert.equal(readOverride().harkUrl, 'https://after-delete.example.com/p/3');
}

// --- 6. 全局层不可写：自动降级到工作区层，且立刻能读回来 ---
{
  // 把全局目录换成一个「文件」占住位置：mkdirSync 会失败，模拟只读/被围栏的部署。
  const blocked = path.join(sandbox, 'blocked');
  fs.writeFileSync(blocked, 'not a directory', 'utf8');
  process.env.DSH_HARK_BRIDGE_HOME = path.join(blocked, 'nested');
  setWorkspaceRoot(workspace);

  const written = writeOverride({ harkUrl: 'https://fallback.example.com/p/4' });
  assert.equal(written, wsFile, `全局写不进去时应落到工作区：${written}`);
  assert.equal(readOverride().harkUrl, 'https://fallback.example.com/p/4', '降级后要立刻读得到');
}

// --- 7. 全局写不进去、又没有工作区：如实抛错，不静默丢配置 ---
{
  setWorkspaceRoot('');
  assert.throws(
    () => writeOverride({ harkUrl: 'https://nowhere.example.com/p/5' }),
    /ENOTDIR|EEXIST|not a directory/i,
    '两层都写不了必须报错，否则用户以为设成功了',
  );
}

// --- 8. normalizeUrl 的边界没被这次改动碰到（回归） ---
{
  assert.equal(normalizeUrl('https://a.com/x/').ok, true);
  assert.equal(normalizeUrl('https://a.com/x/').url, 'https://a.com/x/');
  assert.equal(normalizeUrl('file:///c:/x').ok, false, '只允许 http/https');
  assert.equal(normalizeUrl('   ').ok, false);
}

console.log('store tests passed');
