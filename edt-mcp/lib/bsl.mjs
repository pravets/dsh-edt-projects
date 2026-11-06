// Загрузка BSL Language Server по требованию: явный путь, прямой URL, страницы
// релизов GitHub или API (с проверкой sha256).
//
// GitHub API без токена даёт 60 запросов в час на IP, поэтому источник выбирается
// по наличию токена: с токеном — API первым, без токена — сначала обычные
// страницы релизов (они не в лимите API), а API лишь как резерв.
//
// Все переменные окружения — с префиксом DSH_1C_, чтобы не пересекаться ни с
// чем на машине. Старые имена (BSL_LS_JAR, BSL_MCP_URL…) принимаются как fallback.
//
//   DSH_1C_BSL_LS_JAR        готовый jar (главнее всего остального)
//   DSH_1C_BSL_LS_URL        прямой URL на jar (зеркало, офлайн-раздача)
//   DSH_1C_BSL_LS_VERSION    тег релиза, например v1.0.7 (по умолчанию последний)
//   DSH_1C_BSL_LS_GITHUB_TOKEN  токен GitHub для API (иначе GITHUB_TOKEN, GH_TOKEN)
//   DSH_1C_BSL_LS_CACHE      каталог кэша (по умолчанию $DSH_HOME/cache/bsl-language-server)
//   DSH_1C_BSL_LS_DOWNLOAD   «0» — запретить скачивание
//   DSH_1C_BSL_LS_JAVA       java-команда (по умолчанию java)
//   DSH_1C_BSL_LS_CWD        рабочий каталог сервера (корень исходников)
//   DSH_1C_BSL_LS_ROOT       корень рабочего пространства (главнее CWD)
//   DSH_1C_BSL_LS_PORT       порт встроенного веб-сервера (по умолчанию свободный)
//   DSH_1C_BSL_LS_MODE       hybrid (по умолчанию) или stdio
//   DSH_1C_BSL_MCP_URL       адрес уже запущенного BSL LS по Streamable HTTP
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

export const REPO = '1c-syntax/bsl-language-server';
/** 130 МБ по медленному каналу — запас большой. */
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const ASSET_PATTERN = /-exec\.jar$/;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const API_REPO_URL = `https://api.github.com/repos/${REPO}`;
const REQUEST_TIMEOUT_MS = 30_000;

/** GitHub API ответил лимитом запросов: сообщение должно подсказывать выход. */
export class RateLimitError extends Error {
  constructor(message, { resetAt, status } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
    this.status = status;
  }
}

/** Скачанный файл не совпал по sha256: повтор без сверки недопустим. */
export class IntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrityError';
  }
}

const first = (env, ...names) => names.map((name) => env[name]).find((value) => value !== undefined && value !== '');
const isOff = (value) => ['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());

/** Разбирает окружение в настройки загрузчика. */
export function bslSettings(env = process.env) {
  const download = first(env, 'DSH_1C_BSL_LS_DOWNLOAD');
  return {
    jar: first(env, 'DSH_1C_BSL_LS_JAR', 'BSL_LS_JAR'),
    url: first(env, 'DSH_1C_BSL_LS_URL'),
    version: first(env, 'DSH_1C_BSL_LS_VERSION'),
    githubToken: first(env, 'DSH_1C_BSL_LS_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'),
    mcpUrl: first(env, 'DSH_1C_BSL_MCP_URL', 'BSL_MCP_URL'),
    cacheDir: first(env, 'DSH_1C_BSL_LS_CACHE') ?? join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'bsl-language-server'),
    java: first(env, 'DSH_1C_BSL_LS_JAVA', 'BSL_LS_JAVA') ?? 'java',
    cwd: first(env, 'DSH_1C_BSL_LS_CWD', 'BSL_LS_CWD') ?? '',
    root: first(env, 'DSH_1C_BSL_LS_ROOT', 'DSH_1C_BSL_LS_CWD', 'BSL_LS_CWD') ?? process.cwd(),
    port: first(env, 'DSH_1C_BSL_LS_PORT'),
    mode: (first(env, 'DSH_1C_BSL_LS_MODE') ?? 'hybrid').toLowerCase(),
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
    throw new IntegrityError(`sha256 не совпал: ожидался ${expectSha256}, получен ${actual}`);
  }

  renameSync(partial, target);
  log(`сохранено ${target} (${(received / 1024 / 1024).toFixed(1)} МБ)`);
  return target;
}

/** Предсказуемый адрес ассета: имя файла детерминировано тегом релиза. */
export function predictAsset(tag) {
  const version = String(tag).replace(/^v/, '');
  const name = `bsl-language-server-${version}-exec.jar`;
  return { tag, name, url: `${RELEASES_URL}/download/${tag}/${name}`, sha256: undefined, unverified: true };
}

/** Тег последнего релиза из обычной страницы: она редиректит на releases/tag/<тег>. */
async function latestTag(fetchImpl, log) {
  const url = `${RELEASES_URL}/latest`;
  log(`запрашиваю ${url}`);
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`страница последнего релиза ${url}: HTTP ${response.status}`);
  const location = String(response.url ?? response.headers?.get?.('location') ?? '');
  const tag = location.split('/').filter(Boolean).pop();
  if (tag === undefined || !/^v?\d/.test(tag)) throw new Error(`не удалось определить тег последнего релиза (${location || url})`);
  return tag;
}

/**
 * Разбирает релиз со страниц github.com — они не расходуют лимит API.
 * На странице ассетов рядом с ссылкой лежит и sha256.
 * @returns {{tag: string, name: string, url: string, sha256: string|undefined}}
 */
export async function resolveReleaseViaHtml(fetchImpl, { tag, log = () => {} } = {}) {
  const resolvedTag = tag ?? (await latestTag(fetchImpl, log));
  const url = `${RELEASES_URL}/expanded_assets/${encodeURIComponent(resolvedTag)}`;
  log(`запрашиваю ${url}`);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`страница ассетов ${url}: HTTP ${response.status}`);

  const html = await response.text();
  const name = /href="[^"]*\/([^"/]+-exec\.jar)"/.exec(html)?.[1];
  if (name === undefined) throw new Error(`на ${url} нет ассета *-exec.jar`);
  const start = html.indexOf(name);
  const sha256 = /sha256:([0-9a-f]{64})/i.exec(html.slice(start, start + 2000))?.[1];
  return { tag: resolvedTag, name, url: `${RELEASES_URL}/download/${resolvedTag}/${name}`, sha256 };
}

/** Ассет из GitHub API: JSON содержит и тег, и digest. */
async function apiAsset(tag, { fetchImpl, log, token }) {
  const url = tag === undefined ? `${API_REPO_URL}/releases/latest` : `${API_REPO_URL}/releases/tags/${tag}`;
  return selectExecAsset(await fetchJson(fetchImpl, url, { log, token }));
}

/**
 * Источники релиза по порядку. С токеном API первым, без токена — страницы
 * релизов: лимит 60/ч на IP перестаёт быть условием инициализации.
 * Функции не вызываются здесь: каждый следующий источник пробуется только
 * после отказа предыдущего, поэтому успешная страница не тянет за собой API.
 */
function assetSources(settings, deps) {
  const { fetchImpl, log, token } = deps;
  const tag = settings.version;
  const viaHtml = () => resolveReleaseViaHtml(fetchImpl, { tag, log });
  const viaApi = () => apiAsset(tag, deps);
  const sources = token === undefined ? [viaHtml, viaApi] : [viaApi, viaHtml];
  // Предсказуемый адрес — последний сетевой резерв, только если тег известен.
  if (tag !== undefined) sources.push(async () => predictAsset(tag));
  return sources;
}

/**
 * Возвращает путь к jar: явный, из кэша или скачанный с GitHub.
 * @param settings настройки из bslSettings().
 * @param deps { fetchImpl, log, warn } — подменяются в тестах.
 */
export async function ensureJar(settings, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? log;

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

  const cached = cachedJars(settings.cacheDir);
  // Зафиксированная версия: сначала кэш именно этой версии.
  if (settings.version !== undefined) {
    const target = join(settings.cacheDir, `bsl-language-server-${settings.version.replace(/^v/, '')}-exec.jar`);
    if (existsSync(target)) return target;
  } else if (cached.length > 0) {
    // Версия не задана: годится любой уже скачанный jar.
    log(`использую кэш ${cached[0]}`);
    return cached[0];
  }

  const failures = [];
  let rateLimited;
  const text = (error) => (error instanceof Error ? error.message : String(error));

  for (const source of assetSources(settings, { fetchImpl, log, token: settings.githubToken })) {
    let asset;
    try {
      asset = await source();
    } catch (error) {
      if (error instanceof RateLimitError) rateLimited = error;
      failures.push(error);
      warn(`источник релиза не сработал: ${text(error)}`);
      continue;
    }

    const target = join(settings.cacheDir, asset.name);
    if (existsSync(target)) return target;
    if (asset.unverified === true) {
      warn(`sha256 для ${asset.name} не сверен: страницы релиза недоступны, скачиваю по предсказуемому адресу`);
    }
    try {
      return await downloadToFile(asset.url, target, { fetchImpl, log, expectSha256: asset.sha256 });
    } catch (error) {
      // Подмена файла не лечится повтором без сверки — сразу наверх.
      if (error instanceof IntegrityError) throw error;
      failures.push(error);
      warn(`не удалось скачать ${asset.name}: ${text(error)}`);
    }
  }

  // Любая версия из кэша лучше, чем немигающая инициализация BSL LS.
  if (cached.length > 0) {
    const reason = rateLimited ?? failures[failures.length - 1];
    warn(`релиз недоступен (${reason === undefined ? 'нет источников' : text(reason)}); использую кэш ${basename(cached[0])}`);
    return cached[0];
  }

  if (rateLimited !== undefined) throw rateLimited;
  throw new Error(`не удалось получить релиз BSL LS: ${failures.map(text).join('; ')}`);
}

/** Тело ответа API в виде текста ошибки, если оно есть. */
async function responseMessage(response) {
  try {
    const body = await response.json();
    return typeof body?.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
}

/**
 * Запрос к GitHub API. Токен уходит только на api.github.com — ни на страницы,
 * ни на скачивание ассета. Лимит распознаётся и превращается в понятную ошибку.
 */
export async function fetchJson(fetchImpl, url, { log = () => {}, token } = {}) {
  log(`запрашиваю ${url}`);
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-edt-plugin' };
  if (token !== undefined && new URL(url).host === 'api.github.com') headers.authorization = `Bearer ${token}`;

  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.ok) return response.json();

  const message = await responseMessage(response);
  const header = (name) => response.headers?.get?.(name);
  const resetSeconds = Number(header('x-ratelimit-reset'));
  const resetAt = Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds : undefined;
  const limited = response.status === 429 || (response.status === 403 && (header('x-ratelimit-remaining') === '0' || /rate limit/i.test(message) || resetAt !== undefined));
  if (limited) {
    const until = resetAt === undefined ? '' : ` Сброс лимита не раньше ${new Date(resetAt * 1000).toISOString()}.`;
    throw new RateLimitError(
      `GitHub API исчерпал лимит запросов (без токена — 60/ч на IP).${until}` +
        ' Варианты: задать DSH_1C_BSL_LS_GITHUB_TOKEN, DSH_1C_BSL_LS_VERSION (скачивание без API), DSH_1C_BSL_LS_URL или DSH_1C_BSL_LS_JAR.',
      { resetAt, status: response.status },
    );
  }
  throw new Error(`GitHub API ${url}: HTTP ${response.status}${message === '' ? '' : ` — ${message}`}`);
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

/** Можно ли вообще поднять сервер: без скачивания, пути и кэша он «не настроен». */
export function bslAvailable(settings) {
  if (settings.mcpUrl !== undefined) return true;
  if (settings.jar !== undefined || settings.url !== undefined) return true;
  if (settings.downloadAllowed) return true;
  // Кэш остаётся рабочим источником и при DSH_1C_BSL_LS_DOWNLOAD=0.
  return settings.cacheDir !== undefined && cachedJars(settings.cacheDir).length > 0;
}

/** Свободный порт на loopback. */
export function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: found } = probe.address();
      probe.close(() => resolvePort(found));
    });
  });
}

/** LSP-сообщение с заголовком Content-Length. */
export function lspFrame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Ждёт, пока на порту начнёт приниматься TCP. */
export async function waitForPort(port, { timeoutMs = 180_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const connected = await new Promise((resolveConnect) => {
      const socket = connect({ host: '127.0.0.1', port });
      const settle = (ok) => {
        socket.destroy();
        resolveConnect(ok);
      };
      socket.setTimeout(1000);
      socket.once('connect', () => settle(true));
      socket.once('timeout', () => settle(false));
      socket.once('error', () => settle(false));
    });
    if (connected) return;
    if (Date.now() > deadline) throw new Error(`BSL LS не открыл порт ${port} за ${Math.round(timeoutMs / 1000)} с`);
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

/**
 * Поднимает BSL LS в гибридном режиме: LSP по stdio объявляет рабочие
 * пространства (workspace folders), MCP открывается по Streamable HTTP на том
 * же процессе. Так BSL LS получает корни, которых не умеет передавать
 * dsh-mcp-client (он не объявляет capability roots).
 *
 * @param options.jar путь к jar, options.java команда java, options.root корень
 * @returns {{url: string, root: string, stop: () => Promise<void>}}
 */
export async function startBslSupervisor({ jar, java = 'java', root, port, log = () => {}, timeoutMs = 180_000 }) {
  // Каталог корня должен существовать: иначе spawn падает с ENOENT, и вместо
  // понятной ошибки получается долгое ожидание порта.
  if (!existsSync(root)) throw new Error(`каталог рабочего пространства не найден: ${root}`);

  const actualPort = port === undefined ? await freePort() : Number(port);
  log(`запускаю BSL LS: ${java} -jar ${basename(jar)} lsp --mcp --server.port=${actualPort} (root ${root})`);

  const child = (() => {
    try {
      return spawn(java, ['-jar', jar, 'lsp', '--mcp', `--server.port=${actualPort}`], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Windows может бросить синхронно (нет прав на создание процесса).
      throw new Error(`BSL LS не удалось запустить (${java}): ${error.message}`);
    }
  })();

  // Ошибка запуска и ранний выход должны прерывать ожидание, а не висеть в нём.
  let startupFailure = null;
  const failed = new Promise((_, reject) => {
    child.once('error', (error) => {
      startupFailure = error.code === 'ENOENT' ? `команда ${java} не найдена` : error.message;
      reject(new Error(`BSL LS не запустился: ${startupFailure}`));
    });
    child.once('exit', (code, signal) => {
      startupFailure = `процесс завершился (${signal ?? code})`;
      reject(new Error(`BSL LS завершился при запуске: ${signal ?? code}`));
    });
  });
  failed.catch(() => {});

  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (/ERROR|Exception|WARN.*roots/i.test(text)) log(text.trim().slice(0, 400));
  });

  const rootUri = pathToFileURL(root).href;
  child.stdin.write(
    lspFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: basename(root) || 'workspace' }],
        capabilities: {},
      },
    }),
  );
  child.stdin.write(lspFrame({ jsonrpc: '2.0', method: 'initialized', params: {} }));

  try {
    await Promise.race([waitForPort(actualPort, { timeoutMs }), failed]);
  } catch (error) {
    child.kill();
    throw error;
  }

  return {
    url: `http://127.0.0.1:${actualPort}/mcp`,
    root,
    stop: async () => {
      child.kill();
    },
  };
}

