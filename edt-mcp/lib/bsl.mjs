// Загрузка BSL Language Server по требованию: явный путь, прямой URL или
// последний релиз с GitHub (с проверкой sha256 из API).
//
// Все переменные окружения — с префиксом DSH_1C_, чтобы не пересекаться ни с
// чем на машине. Старые имена (BSL_LS_JAR, BSL_MCP_URL…) принимаются как fallback.
//
//   DSH_1C_BSL_LS_JAR        готовый jar (главнее всего остального)
//   DSH_1C_BSL_LS_URL        прямой URL на jar (зеркало, офлайн-раздача)
//   DSH_1C_BSL_LS_VERSION    тег релиза, например v1.0.7 (по умолчанию последний)
//   DSH_1C_BSL_LS_CACHE      каталог кэша (по умолчанию $DSH_HOME/cache/bsl-language-server)
//   DSH_1C_BSL_LS_DOWNLOAD   «0» — запретить скачивание
//   DSH_1C_BSL_LS_JAVA       java-команда (по умолчанию java)
//   DSH_1C_BSL_LS_CWD        рабочий каталог сервера (корень исходников)
//   DSH_1C_BSL_MCP_URL       адрес уже запущенного BSL LS по Streamable HTTP
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';

export const REPO = '1c-syntax/bsl-language-server';
/** 130 МБ по медленному каналу — запас большой. */
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const ASSET_PATTERN = /-exec\.jar$/;

const first = (env, ...names) => names.map((name) => env[name]).find((value) => value !== undefined && value !== '');
const isOff = (value) => ['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());

/** Разбирает окружение в настройки загрузчика. */
export function bslSettings(env = process.env) {
  const download = first(env, 'DSH_1C_BSL_LS_DOWNLOAD');
  return {
    jar: first(env, 'DSH_1C_BSL_LS_JAR', 'BSL_LS_JAR'),
    url: first(env, 'DSH_1C_BSL_LS_URL'),
    version: first(env, 'DSH_1C_BSL_LS_VERSION'),
    mcpUrl: first(env, 'DSH_1C_BSL_MCP_URL', 'BSL_MCP_URL'),
    cacheDir: first(env, 'DSH_1C_BSL_LS_CACHE') ?? join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'bsl-language-server'),
    java: first(env, 'DSH_1C_BSL_LS_JAVA', 'BSL_LS_JAVA') ?? 'java',
    cwd: first(env, 'DSH_1C_BSL_LS_CWD', 'BSL_LS_CWD') ?? '',
    downloadAllowed: download === undefined ? true : !isOff(download),
  };
}

/** Выбирает из релиза исполняемый jar и его sha256. */
export function selectExecAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((item) => ASSET_PATTERN.test(String(item.name)));
  if (!asset) throw new Error(`в релизе ${release?.tag_name ?? '?'} нет ассета *-exec.jar`);
  const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : undefined;
  return {
    tag: release.tag_name,
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256: digest,
  };
}

function cachedJars(cacheDir) {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir)
    .filter((name) => name.endsWith('-exec.jar'))
    .map((name) => join(cacheDir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

async function downloadToFile(url, target, { fetchImpl, log, timeoutMs = DOWNLOAD_TIMEOUT_MS, expectSha256 }) {
  mkdirSync(join(target, '..'), { recursive: true });
  const partial = `${target}.part`;
  log(`скачиваю ${url}`);

  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || response.body === null) throw new Error(`загрузка ${url} не удалась: HTTP ${response.status}`);

  const hash = createHash('sha256');
  const stream = createWriteStream(partial);
  let received = 0;
  let lastReport = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      hash.update(chunk);
      received += chunk.length;
      if (!stream.write(chunk)) await new Promise((done) => stream.once('drain', done));
      if (received - lastReport >= 10 * 1024 * 1024) {
        lastReport = received;
        log(`получено ${(received / 1024 / 1024).toFixed(1)} МБ`);
      }
    }
  } finally {
    await new Promise((done, fail) => stream.end((error) => (error ? fail(error) : done())));
  }

  const actual = hash.digest('hex');
  if (expectSha256 !== undefined && actual !== expectSha256) {
    rmSync(partial, { force: true });
    throw new Error(`sha256 не совпал: ожидался ${expectSha256}, получен ${actual}`);
  }

  renameSync(partial, target);
  log(`сохранено ${target} (${(received / 1024 / 1024).toFixed(1)} МБ)`);
  return target;
}

/**
 * Возвращает путь к jar: явный, из кэша или скачанный с GitHub.
 * @param settings настройки из bslSettings().
 * @param deps { fetchImpl, log } — подменяются в тестах.
 */
export async function ensureJar(settings, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const log = deps.log ?? (() => {});

  if (settings.jar !== undefined) {
    if (!existsSync(settings.jar)) throw new Error(`DSH_1C_BSL_LS_JAR указывает на ${settings.jar}, файла нет`);
    return settings.jar;
  }

  if (settings.url !== undefined) {
    const target = join(settings.cacheDir, basename(new URL(settings.url).pathname) || 'bsl-language-server-exec.jar');
    if (existsSync(target)) return target;
    return downloadToFile(settings.url, target, { fetchImpl, log });
  }

  if (!settings.downloadAllowed) {
    throw new Error('BSL LS не настроен: задайте DSH_1C_BSL_LS_JAR (или URL) либо разрешите скачивание (DSH_1C_BSL_LS_DOWNLOAD не 0)');
  }

  // Зафиксированная версия: сначала кэш, потом API этого тега.
  if (settings.version !== undefined) {
    const target = join(settings.cacheDir, `bsl-language-server-${settings.version.replace(/^v/, '')}-exec.jar`);
    if (existsSync(target)) return target;
    const release = await fetchJson(fetchImpl, `https://api.github.com/repos/${REPO}/releases/tags/${settings.version}`, log);
    const asset = selectExecAsset(release);
    return downloadToFile(asset.url, join(settings.cacheDir, asset.name), { fetchImpl, log, expectSha256: asset.sha256 });
  }

  // Версия не задана: годится любой уже скачанный jar, иначе спрашиваем последний релиз.
  const cached = cachedJars(settings.cacheDir);
  if (cached.length > 0) {
    log(`использую кэш ${cached[0]}`);
    return cached[0];
  }

  const release = await fetchJson(fetchImpl, `https://api.github.com/repos/${REPO}/releases/latest`, log);
  const asset = selectExecAsset(release);
  return downloadToFile(asset.url, join(settings.cacheDir, asset.name), { fetchImpl, log, expectSha256: asset.sha256 });
}

async function fetchJson(fetchImpl, url, log) {
  log(`запрашиваю ${url}`);
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-edt-plugin' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${url}: HTTP ${response.status}`);
  return response.json();
}

/**
 * Собирает параметры монтирования BSL LS.
 * @returns {{transport: 'stdio', command: string, args: string[], cwd: string} |
 *           {transport: 'streamable-http', url: string}}
 */
export async function resolveBsl(settings, deps = {}) {
  if (settings.mcpUrl !== undefined) return { transport: 'streamable-http', url: settings.mcpUrl };
  const jar = await ensureJar(settings, deps);
  return { transport: 'stdio', command: settings.java, args: ['-jar', jar, 'mcp'], cwd: settings.cwd };
}

/** Можно ли вообще поднять сервер: без скачивания и без пути он «не настроен». */
export function bslAvailable(settings) {
  if (settings.mcpUrl !== undefined) return true;
  if (settings.jar !== undefined || settings.url !== undefined) return true;
  return settings.downloadAllowed;
}
