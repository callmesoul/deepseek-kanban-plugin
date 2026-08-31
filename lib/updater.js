import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  PLUGIN_NAME,
  UPDATE_SOURCE,
  parseStableVersion,
  resolveInstalledPackagePath,
  writeUpdateState,
} from './update.js';

function outputTail(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`.trim().slice(-6000);
}

export function parseUpdaterArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`无效更新器参数：${key || '（空）'}`);
    result[key.slice(2)] = value;
  }
  return result;
}

export async function runUpdater(options, runCommand = spawnSync) {
  const { tag, state: statePath, dsh: dshCliPath, profile, profileDir, restartService } = options;
  const parsed = parseStableVersion(tag);
  if (!parsed || tag !== `v${parsed.version}`) throw new Error(`拒绝安装无效版本：${tag}`);
  if (!statePath || !dshCliPath || !profile || !profileDir) throw new Error('更新器缺少必要参数');

  const baseState = {
    targetVersion: parsed.version,
    tagName: tag,
    startedAt: new Date().toISOString(),
  };
  await writeUpdateState({ ...baseState, status: 'installing' }, statePath);

  const nodeBinDir = dirname(process.execPath);
  const pathValue = [nodeBinDir, process.env.PATH || ''].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
  const install = runCommand(
    process.execPath,
    [dshCliPath, 'plugin', '--profile', profile, 'add', `${UPDATE_SOURCE}#${tag}`],
    {
      cwd: profileDir,
      env: { ...process.env, PATH: pathValue },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    },
  );

  if (install.error || install.status !== 0) {
    const message = install.error?.message || outputTail(install) || `dsh plugin 退出码 ${install.status}`;
    await writeUpdateState({
      ...baseState,
      status: 'failed',
      message: `安装失败：${message}`,
      finishedAt: new Date().toISOString(),
    }, statePath);
    return false;
  }

  const installedManifestPath = resolveInstalledPackagePath(profileDir);
  let installedVersion = null;
  if (installedManifestPath) {
    try {
      installedVersion = JSON.parse(await readFile(installedManifestPath, 'utf8')).version;
    } catch {
      // The explicit version check below reports a stable, user-facing error.
    }
  }
  if (installedVersion !== parsed.version) {
    await writeUpdateState({
      ...baseState,
      status: 'failed',
      message: `安装完成但版本校验失败：期望 ${parsed.version}，实际 ${installedVersion || '未知'}`,
      finishedAt: new Date().toISOString(),
    }, statePath);
    return false;
  }

  if (restartService && process.platform !== 'win32') {
    const active = runCommand('systemctl', ['--user', 'is-active', '--quiet', restartService], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!active.error && active.status === 0) {
      await writeUpdateState({
        ...baseState,
        status: 'restarting',
        installedVersion,
        message: '插件已安装，正在重启 DSH…',
      }, statePath);
      const restart = runCommand('systemctl', ['--user', '--no-block', 'restart', restartService], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (!restart.error && restart.status === 0) return true;
    }
  }

  await writeUpdateState({
    ...baseState,
    status: 'succeeded',
    installedVersion,
    requiresRestart: true,
    message: '插件已安装；请重启 DSH 使新版本生效。',
    finishedAt: new Date().toISOString(),
  }, statePath);
  return true;
}

async function main() {
  let args;
  try {
    args = parseUpdaterArgs(process.argv.slice(2));
    await runUpdater(args);
  } catch (error) {
    if (args?.state) {
      await writeUpdateState({
        status: 'failed',
        targetVersion: parseStableVersion(args.tag)?.version ?? null,
        tagName: args.tag ?? null,
        message: error?.message || String(error),
        finishedAt: new Date().toISOString(),
      }, args.state).catch(() => {});
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
