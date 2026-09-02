import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLUGIN_VERSION,
  classifyInstallSpec,
  clearUpdateState,
  compareStableVersions,
  normalizeRelease,
  parseStableVersion,
  readUpdateState,
  writeUpdateState,
} from '../lib/update.js';
import { parseUpdaterArgs, runUpdater } from '../lib/updater.js';

assert.equal(PLUGIN_VERSION, '0.7.0');
assert.deepEqual(parseStableVersion('v1.2.3'), { version: '1.2.3', parts: [1, 2, 3] });
assert.equal(parseStableVersion('1.2.3-beta.1'), null);
assert.equal(compareStableVersions('0.6.0', '0.5.9'), 1);
assert.equal(compareStableVersions('0.6.0', 'v0.6.0'), 0);
assert.equal(compareStableVersions('0.5.9', '0.6.0'), -1);

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
assert.deepEqual(parseUpdaterArgs(['--tag', 'v0.7.0', '--profile', 'web']), {
  tag: 'v0.7.0',
  profile: 'web',
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
    dsh: '/opt/dsh/lib/bin.js',
    profile: 'web',
    profileDir,
    restartService: 'dsh-web.service',
  }, noSystemd);
  assert.equal(installed, true);
  assert.deepEqual(calls[0][1], [
    '/opt/dsh/lib/bin.js',
    'plugin',
    '--profile',
    'web',
    'add',
    'github:callmesoul/deepseek-kanban-plugin#v0.7.0',
  ]);
  const completed = await readUpdateState(statePath);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.requiresRestart, true);

  const systemdCalls = [];
  const withSystemd = (command, args) => {
    systemdCalls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.equal(await runUpdater({
    tag: 'v0.7.0',
    state: statePath,
    dsh: '/opt/dsh/lib/bin.js',
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
    dsh: '/opt/dsh/lib/bin.js',
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
      dsh: '/opt/dsh/lib/bin.js',
      profile: 'web',
      profileDir,
    }, noSystemd),
    /无效版本/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('test-update: ok');
