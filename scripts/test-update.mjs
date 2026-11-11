import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLUGIN_VERSION,
  classifyInstallSpec,
  clearUpdateState,
  compareStableVersions,
  detectProfileName,
  normalizeRelease,
  parseStableVersion,
  readUpdateState,
  resolveDshInvocation,
  writeUpdateState,
} from '../lib/update.js';
import { parseUpdaterArgs, runUpdater } from '../lib/updater.js';

assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/);
assert.deepEqual(parseStableVersion('v1.2.3'), { version: '1.2.3', parts: [1, 2, 3] });
assert.equal(parseStableVersion('1.2.3-beta.1'), null);
assert.equal(compareStableVersions('0.6.0', '0.5.9'), 1);
assert.equal(compareStableVersions('0.6.0', 'v0.6.0'), 0);
assert.equal(compareStableVersions('0.5.9', '0.6.0'), -1);

// DSH 0.2.x 桌面版把 profile 目录作为位置参数传入，argv 里没有 --profile 也没有 web。
const desktopArgv = [
  'C:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe',
  'C:\\Apps\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
  'C:\\Apps\\DeepSeek Harness\\resources\\app.asar\\dsh',
  'C:\\Users\\me\\.dsh\\profiles\\desktop',
  'C:\\Apps\\DeepSeek Harness\\resources\\runtime\\primary-runtime',
];
const posixProfileArgv = ['node', '/usr/lib/dsh/lib/bin.js', '/home/me/.dsh/profiles/headless/'];
assert.equal(detectProfileName(desktopArgv), 'desktop');
assert.equal(detectProfileName(posixProfileArgv), 'headless');
assert.equal(detectProfileName(['node', '/usr/lib/dsh/lib/bin.js', '--profile', 'work']), 'work');
assert.equal(detectProfileName(['node', '/usr/lib/dsh/lib/bin.js', 'web']), 'web');

// 普通 node 安装：argv[1] 就是 CLI 主模块。
const nodeCliInvocation = resolveDshInvocation(['/usr/bin/node', '/usr/lib/dsh/lib/bin.js', 'web'], '/usr/bin/node');
assert.equal(nodeCliInvocation.source, 'node-cli');
assert.deepEqual(nodeCliInvocation.prefixArgs, ['/usr/lib/dsh/lib/bin.js']);
assert.deepEqual(nodeCliInvocation.env, {});

// 桌面版：argv[1] 是 dsh-desktop-host/lib/index.js，不能当作 CLI 直接执行。
// 未安装桌面运行时（此处即是）时安全回退到 node-cli，不会抛错。
const desktopInvocation = resolveDshInvocation(desktopArgv, '/usr/bin/node');
assert.ok(['desktop-host', 'node-cli'].includes(desktopInvocation.source));

assert.equal(classifyInstallSpec('file:/tmp/plugin').disabledReason, 'development-install');
assert.equal(classifyInstallSpec('link:../plugin').disabledReason, 'development-install');
assert.equal(classifyInstallSpec('github:callmesoul/deepseek-kanban-plugin').enabled, true);
assert.equal(classifyInstallSpec('github:callmesoul/deepseek-kanban-plugin#v0.6.0').enabled, true);
assert.equal(classifyInstallSpec('github:somebody/other-plugin').disabledReason, 'unsupported-source');

assert.deepEqual(
  normalizeRelease({
    tag_name: 'v0.7.0',
    name: '更新测试',
    body: 'notes',
    html_url: 'https://github.com/callmesoul/deepseek-kanban-plugin/releases/tag/v0.7.0',
    published_at: '2026-09-01T00:00:00Z',
    draft: false,
    prerelease: false,
  }),
  {
    version: '0.7.0',
    tagName: 'v0.7.0',
    name: '更新测试',
    notes: 'notes',
    publishedAt: '2026-09-01T00:00:00Z',
    url: 'https://github.com/callmesoul/deepseek-kanban-plugin/releases/tag/v0.7.0',
  },
);
assert.equal(normalizeRelease({ tag_name: 'v0.7.0', prerelease: true }), null);
assert.throws(() => normalizeRelease({ tag_name: 'main' }), /语义化版本/);
assert.deepEqual(parseUpdaterArgs(['--tag', 'v0.7.0', '--profile', 'desktop']), {
  tag: 'v0.7.0',
  profile: 'desktop',
});
assert.throws(() => parseUpdaterArgs(['--tag']), /无效更新器参数/);

const root = await mkdtemp(join(tmpdir(), 'kanban-update-test-'));
try {
  const statePath = join(root, 'state', 'update.json');
  await writeUpdateState({ status: 'installing', targetVersion: '0.7.0' }, statePath);
  assert.equal((await readUpdateState(statePath)).targetVersion, '0.7.0');
  await clearUpdateState(statePath);
  assert.equal(await readUpdateState(statePath), null);

  const profileDir = join(root, 'profile');
  const installedDir = join(profileDir, 'node_modules', '@deepseek-kanban', 'plugin');
  await mkdir(installedDir, { recursive: true });
  await writeFile(join(installedDir, 'package.json'), '{"version":"0.7.0"}\n');

  const calls = [];
  const noSystemd = (command, args) => {
    calls.push([command, args]);
    if (command === 'systemctl') return { status: 3, stdout: '', stderr: '' };
    return { status: 0, stdout: 'installed', stderr: '' };
  };
  const installed = await runUpdater({
    tag: 'v0.7.0',
    state: statePath,
    dsh: '/usr/bin/node',
    profile: 'desktop',
    profileDir,
    restartService: 'dsh-desktop.service',
  }, noSystemd);
  assert.equal(installed, true);
  assert.deepEqual(calls[0][1], [
    'plugin',
    '--profile',
    'desktop',
    'add',
    'github:callmesoul/deepseek-kanban-plugin#v0.7.0',
  ]);
  const completed = await readUpdateState(statePath);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.requiresRestart, true);

  // 桌面版：命令是宿主可执行文件 + --expose-internals <cli.js>，并带 ELECTRON_RUN_AS_NODE。
  const desktopCalls = [];
  const desktopRunner = (command, args, options) => {
    desktopCalls.push([command, args, options]);
    return { status: 0, stdout: 'installed', stderr: '' };
  };
  assert.equal(await runUpdater({
    tag: 'v0.7.0',
    state: statePath,
    dsh: 'C:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe',
    dshArgs: JSON.stringify([
      '--expose-internals',
      'C:\\Apps\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
    ]),
    dshEnv: JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }),
    profile: 'desktop',
    profileDir,
  }, desktopRunner), true);
  assert.equal(desktopCalls[0][0], 'C:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe');
  assert.deepEqual(desktopCalls[0][1], [
    '--expose-internals',
    'C:\\Apps\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
    'plugin',
    '--profile',
    'desktop',
    'add',
    'github:callmesoul/deepseek-kanban-plugin#v0.7.0',
  ]);
  assert.equal(desktopCalls[0][2].env.ELECTRON_RUN_AS_NODE, '1');

  const systemdCalls = [];
  const withSystemd = (command, args) => {
    systemdCalls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.equal(await runUpdater({
    tag: 'v0.7.0',
    state: statePath,
    dsh: '/usr/bin/node',
    profile: 'web',
    profileDir,
    restartService: 'dsh-web.service',
  }, withSystemd), true);
  assert.deepEqual(systemdCalls.at(-1), [
    'systemctl',
    ['--user', '--no-block', 'restart', 'dsh-web.service'],
  ]);
  assert.equal((await readUpdateState(statePath)).status, 'restarting');

  const failed = await runUpdater({
    tag: 'v0.7.0',
    state: statePath,
    dsh: '/usr/bin/node',
    profile: 'web',
    profileDir,
    restartService: 'dsh-web.service',
  }, () => ({ status: 1, stdout: '', stderr: 'network unavailable' }));
  assert.equal(failed, false);
  assert.match((await readUpdateState(statePath)).message, /network unavailable/);
  await assert.rejects(
    runUpdater({
      tag: 'main',
      state: statePath,
      dsh: '/usr/bin/node',
      profile: 'web',
      profileDir,
    }, noSystemd),
    /无效版本/,
  );
  await assert.rejects(
    runUpdater({
      tag: 'v0.7.0',
      state: statePath,
      dsh: '/usr/bin/node',
      dshArgs: 'not-json',
      profile: 'web',
      profileDir,
    }, noSystemd),
    /合法 JSON/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('test-update: ok');
