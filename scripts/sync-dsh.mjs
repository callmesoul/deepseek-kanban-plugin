#!/usr/bin/env node
/**
 * sync-dsh.mjs — 把本地构建产物安装进某个 DSH profile（file: 模式）。
 *
 * 背景：DSH 0.2.x 起，profile 里安装的插件与本机 DSH 安装树共享同一份
 * `@deepseek-ai/*` 与 `zod`（由 app-boot 的运行时解析器统一路由），因此不再需要
 * 老版 deploy-local.sh 里手工 `ln -sfn` 指回全局依赖的做法。
 *
 * 用法：
 *   node scripts/sync-dsh.mjs                       # 默认 --profile desktop
 *   node scripts/sync-dsh.mjs --profile web
 *   node scripts/sync-dsh.mjs --dsh /path/to/dsh.cmd --profile desktop
 *   node scripts/sync-dsh.mjs --dry-run             # 只打印将要执行的命令
 *   node scripts/sync-dsh.mjs --stage /tmp/stage    # 手动指定中转目录
 *
 * 可用环境变量：DSH_CLI（CLI 路径）、DSH_PROFILE（默认 profile）、DSH_HOME（默认 ~/.dsh）、
 * DSH_SYNC_STAGE（默认中转目录）。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@deepseek-kanban/plugin';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(code = 0) {
  const text = `用法: node scripts/sync-dsh.mjs [--profile <name>] [--dsh <cli>] [--stage <dir>] [--dry-run]

  --profile <name>  目标 DSH profile，默认取 DSH_PROFILE 或 "desktop"
  --dsh <cli>       指定 dsh CLI 可执行文件（默认依次尝试 DSH_CLI、PATH、桌面版安装路径）
  --stage <dir>     安装前把产物复制到该目录再安装（默认 DSH_SYNC_STAGE 或用户缓存目录）
  --dry-run         只打印将要执行的命令，不做任何改动
`;
  (code === 0 ? process.stdout : process.stderr).write(text);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    profile: process.env.DSH_PROFILE || 'desktop',
    dsh: process.env.DSH_CLI,
    stage: process.env.DSH_SYNC_STAGE,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile' || arg === '-p') {
      const value = argv[++index];
      if (value === undefined) usage(2);
      options.profile = value;
    } else if (arg.startsWith('--profile=')) {
      options.profile = arg.slice('--profile='.length);
    } else if (arg === '--dsh') {
      const value = argv[++index];
      if (value === undefined) usage(2);
      options.dsh = value;
    } else if (arg.startsWith('--dsh=')) {
      options.dsh = arg.slice('--dsh='.length);
    } else if (arg === '--stage') {
      const value = argv[++index];
      if (value === undefined) usage(2);
      options.stage = value;
    } else if (arg.startsWith('--stage=')) {
      options.stage = arg.slice('--stage='.length);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      usage(0);
    } else {
      process.stderr.write(`sync-dsh: 未知参数 ${JSON.stringify(arg)}\n`);
      usage(2);
    }
  }
  return options;
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function profileDir(profile) {
  return join(dshHome(), 'profiles', profile);
}

/** 桌面版安装目录里的 CLI 启动器，按平台给出常见位置。 */
function desktopCliCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], localAppData && join(localAppData, 'Programs')]) {
      if (!base) continue;
      candidates.push(join(base, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
  } else {
    candidates.push(join(homedir(), '.local', 'share', 'deepseek-harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'));
  }
  return candidates;
}

function resolveDsh(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`找不到指定的 dsh CLI：${explicit}`);
    return { command: explicit, source: '--dsh/DSH_CLI' };
  }
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' });
  const found =
    onPath.status === 0
      ? onPath.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)[0]
      : undefined;
  if (found && existsSync(found)) return { command: found, source: 'PATH' };
  for (const candidate of desktopCliCandidates()) {
    if (existsSync(candidate)) return { command: candidate, source: 'desktop 安装目录' };
  }
  throw new Error(
    '找不到 dsh CLI。请在 DSH 主机上用 `dsh plugin --profile <name> add <package>` 安装，或用 --dsh 指定启动器路径。',
  );
}

function quoteWindows(argument) {
  return `"${String(argument).replaceAll('"', '\\"')}"`;
}

/** 拼出 Windows 命令行；`.cmd` 只能交给 shell 执行（Node 18.20+ 起禁止直接 spawn）。 */
function windowsCommandLine(cli, args) {
  return [quoteWindows(cli.command), ...args.map(quoteWindows)].join(' ');
}

/** 运行 CLI；Windows 下 .cmd 只能经 shell 启动（Node 18.20+ 的安全限制）。 */
function runDsh(cli, args, options) {
  process.stdout.write(`sync-dsh: ${[cli.command, ...args].join(' ')}\n`);
  if (options.dryRun) return 0;
  const cwd = profileDir(options.profile);
  const result =
    process.platform === 'win32'
      ? spawnSync(windowsCommandLine(cli, args), { cwd, stdio: 'inherit', shell: true })
      : spawnSync(cli.command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function installedVersion(profile) {
  const manifest = join(profileDir(profile), 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json');
  if (!existsSync(manifest)) return undefined;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version;
  } catch {
    return undefined;
  }
}

/** 默认中转目录：放在本地盘的用户缓存下，跨次运行复用，避免每次重建。 */
function defaultStageDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'dsh-kanban-plugin-stage');
  }
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'dsh-kanban-plugin-stage');
}

/**
 * 把 `files` 里声明的产物（外加 package.json）复制到中转目录。
 *
 * Windows 版 pnpm 无法从 `\\wsl.localhost\...` 这类 UNC 路径安装 file: 依赖，
 * 所以先把产物摊到本地盘再安装。中转目录保留在原地：profile 的 package.json
 * 会记录这个 file: 路径，删掉它会让后续 pnpm install 失败。
 */
function stagePackage(destination) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const entries = ['package.json', ...(Array.isArray(manifest.files) ? manifest.files : [])];
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const source = join(root, entry);
    if (!existsSync(source)) {
      process.stderr.write(`sync-dsh: 跳过缺失文件 ${entry}\n`);
      continue;
    }
    cpSync(source, join(destination, entry), { recursive: true, dereference: true });
  }
  return destination;
}

const options = parseArgs(process.argv.slice(2));
const local = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!existsSync(join(root, 'lib', 'index.js')) || !existsSync(join(root, 'lib', 'client.js'))) {
  process.stderr.write('sync-dsh: lib/index.js 或 lib/client.js 缺失，请先运行 pnpm build\n');
  process.exit(1);
}

const target = profileDir(options.profile);
if (!existsSync(join(target, 'package.json'))) {
  process.stderr.write(
    `sync-dsh: profile 目录 ${target} 尚未初始化。\n` +
      '桌面版会独占 desktop profile：请先启动一次 DeepSeek Harness 桌面版再重试。\n',
  );
  process.exit(1);
}

let cli;
try {
  cli = resolveDsh(options.dsh);
} catch (error) {
  process.stderr.write(`sync-dsh: ${error.message}\n`);
  process.exit(1);
}
process.stdout.write(`sync-dsh: 使用 ${cli.command}（来自 ${cli.source}），目标 profile "${options.profile}"\n`);

// UNC（\\wsl.localhost、\\server\share）在 Windows 下 pnpm 装不了，必须中转。
const needsStaging = options.stage !== undefined || (process.platform === 'win32' && root.startsWith('\\\\'));
let installSource = root;
if (needsStaging) {
  const stage = resolve(options.stage ?? defaultStageDir());
  if (options.dryRun) {
    process.stdout.write(`sync-dsh: 将把产物复制到中转目录 ${stage}\n`);
  } else {
    stagePackage(stage);
    process.stdout.write(`sync-dsh: 已把产物复制到中转目录 ${stage}\n`);
  }
  installSource = stage;
}

const removeStatus = runDsh(cli, ['plugin', '--profile', options.profile, 'remove', PACKAGE_NAME], options);
if (removeStatus !== 0) {
  // 未安装时 pnpm remove 会报错，这里不视为失败。
  process.stdout.write('sync-dsh: 移除旧版本未成功（可能本来就没装），继续安装\n');
}

const addStatus = runDsh(cli, ['plugin', '--profile', options.profile, 'add', `file:${installSource}`], options);
if (addStatus !== 0) {
  process.stderr.write(
    `sync-dsh: 安装失败（exit ${addStatus}）。\n` +
      '如果提示插件与当前 dsh 版本不兼容，请先修正 peerDependencies，再按提示执行 dsh plugin allow-version。\n',
  );
  process.exit(addStatus);
}

if (options.dryRun) {
  process.stdout.write('sync-dsh: dry-run 结束，未做任何改动\n');
  process.exit(0);
}

const version = installedVersion(options.profile);
if (version === undefined) {
  process.stderr.write(`sync-dsh: 安装后仍未在 ${target} 找到 ${PACKAGE_NAME}，请检查 pnpm 输出\n`);
  process.exit(1);
}
if (version !== local.version) {
  process.stderr.write(`sync-dsh: 版本不一致：本地 ${local.version}，profile 内 ${version}\n`);
  process.exit(1);
}

process.stdout.write(
  `sync-dsh: 已安装 ${PACKAGE_NAME}@${version} 到 profile "${options.profile}"。\n` +
    '重启 DeepSeek Harness 后生效（侧边栏底部出现「任务看板」入口）。\n',
);
