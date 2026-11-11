import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = '@deepseek-kanban/plugin';
export const UPDATE_REPOSITORY = 'callmesoul/deepseek-kanban-plugin';
export const UPDATE_SOURCE = `github:${UPDATE_REPOSITORY}`;
export const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageManifest = JSON.parse(readFileSync(packagePath, 'utf8'));
export const PLUGIN_VERSION = packageManifest.version;

export function parseStableVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}

export function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) throw new Error(`无法比较版本号：${left} / ${right}`);
  for (let index = 0; index < a.parts.length; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  }
  return 0;
}

export function normalizeRelease(payload) {
  if (!payload || payload.draft || payload.prerelease) return null;
  const parsed = parseStableVersion(payload.tag_name);
  if (!parsed) throw new Error(`GitHub Release 标签不是稳定语义化版本：${payload.tag_name || '（空）'}`);
  return {
    version: parsed.version,
    tagName: `v${parsed.version}`,
    name: typeof payload.name === 'string' && payload.name.trim()
      ? payload.name.trim()
      : `v${parsed.version}`,
    notes: typeof payload.body === 'string' ? payload.body.slice(0, 4000) : '',
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
    url: typeof payload.html_url === 'string'
      ? payload.html_url
      : `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${parsed.version}`,
  };
}

export async function fetchLatestPluginRelease(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 运行时不支持 fetch');
  const response = await fetchImpl(UPDATE_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `${PLUGIN_NAME}/${PLUGIN_VERSION}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub Release 检查失败（HTTP ${response.status}）`);
  return normalizeRelease(await response.json());
}

/** 从 `<...>/profiles/<name>` 形式的路由参数里取出 profile 名。 */
function profileNameFromArgv(argv) {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    const match = /[\\/]profiles[\\/]([^\\/]+)[\\/]?$/u.exec(arg);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * 探测当前宿主使用的 profile 名。
 *
 * DSH 0.2.x 的桌面版把 profile 目录直接作为命令行参数传给宿主进程
 * （`… <resources>/app.asar/dsh <profileDir> <runtimeDir> …`），argv 里既没有
 * `--profile` 也没有 `web`，旧逻辑会一律返回 `web`，导致读错 profile、
 * 更新检查被误判成「未安装」。这里补上按 profiles 路径反查的规则。
 */
export function detectProfileName(argv = process.argv) {
  const profileIndex = argv.indexOf('--profile');
  if (profileIndex >= 0 && argv[profileIndex + 1]) return argv[profileIndex + 1];
  const fromArgv = profileNameFromArgv(argv);
  if (fromArgv) return fromArgv;
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
  // 兼容 DSH 0.1.x 的 `dsh web` 写法。
  if (argv.includes('web')) return 'web';
  return 'web';
}

/**
 * 解析「怎样调用 dsh 插件管理 CLI」。
 *
 * 普通 `dsh`（node 安装）的 argv[1] 就是 CLI 主模块，直接用当前 node 跑即可；
 * 但桌面宿主的 argv[1] 是 `dsh-desktop-host/lib/index.js`，照旧执行会把整个
 * 桌面宿主重新拉起来（并用 plugin 参数去当 profile 目录），一键更新必然失败。
 * 桌面版真正的 CLI 在 `<app.asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`，
 * 需要以 Electron 的 node 模式（ELECTRON_RUN_AS_NODE=1）启动 —— 与 dsh.cmd 一致。
 *
 * asar 内部路径在普通 Node 里 existsSync 不到，因此这里以「argv[2] 指向 app.asar/dsh」
 * 作为判据，再用同一安装目录下的 CLI 启动器印证它确实存在。
 */
export function resolveDshInvocation(argv = process.argv, execPath = process.execPath) {
  const scriptPath = argv[1];
  if (!scriptPath) return null;

  const appRoot = argv[2];
  if (typeof appRoot === 'string' && /(?:^|[\\/])app\.asar[\\/]dsh[\\/]?$/u.test(appRoot)) {
    const resourcesRoot = dirname(dirname(appRoot.replace(/[\\/]+$/u, '')));
    const launcher = join(resourcesRoot, 'runtime', 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
    const cliModule = join(appRoot.replace(/[\\/]+$/u, ''), 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    if (existsSync(launcher)) {
      return {
        command: execPath,
        prefixArgs: ['--expose-internals', cliModule],
        env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: execPath },
        source: 'desktop-host',
      };
    }
  }

  return { command: execPath, prefixArgs: [scriptPath], env: {}, source: 'node-cli' };
}

export function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function classifyInstallSpec(spec) {
  if (!spec) return { enabled: false, disabledReason: 'not-installed' };
  if (/^(?:file|link|workspace):/i.test(spec)) {
    return { enabled: false, disabledReason: 'development-install' };
  }
  const knownGitHubSource = [
    /^github:callmesoul\/deepseek-kanban-plugin(?:#.+)?$/i,
    /^callmesoul\/deepseek-kanban-plugin(?:#.+)?$/i,
    /^git\+https:\/\/github\.com\/callmesoul\/deepseek-kanban-plugin(?:\.git)?(?:#.+)?$/i,
    /^https:\/\/github\.com\/callmesoul\/deepseek-kanban-plugin(?:\.git)?(?:#.+)?$/i,
  ].some((pattern) => pattern.test(spec));
  if (!knownGitHubSource) return { enabled: false, disabledReason: 'unsupported-source' };
  return { enabled: true, disabledReason: null };
}

export async function readInstallContext(profileName = detectProfileName()) {
  const profileDir = join(resolveDshHome(), 'profiles', profileName);
  const manifestPath = join(profileDir, 'package.json');
  let installedSpec = null;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    installedSpec = manifest.dependencies?.[PLUGIN_NAME] ?? null;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    profileName,
    profileDir,
    installedSpec,
    ...classifyInstallSpec(installedSpec),
  };
}

export function resolveUpdateStatePath() {
  return join(resolveDshHome(), 'updates', 'deepseek-kanban.json');
}

export async function readUpdateState(statePath = resolveUpdateStatePath()) {
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeUpdateState(state, statePath = resolveUpdateStatePath()) {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tempPath, statePath);
  return state;
}

export async function clearUpdateState(statePath = resolveUpdateStatePath()) {
  await unlink(statePath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

export function resolveInstalledPackagePath(profileDir) {
  const path = join(profileDir, 'node_modules', '@deepseek-kanban', 'plugin', 'package.json');
  return existsSync(path) ? path : null;
}
