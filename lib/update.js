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

export function detectProfileName(argv = process.argv) {
  const profileIndex = argv.indexOf('--profile');
  if (profileIndex >= 0 && argv[profileIndex + 1]) return argv[profileIndex + 1];
  if (argv.includes('web')) return 'web';
  return process.env.DSH_PROFILE || 'web';
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
