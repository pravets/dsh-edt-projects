// Окружение 1C:EDT для git worktree: настройки, файлы состояния, порт,
// установка EDT и проверка готовности.
//
// Модуль намеренно не запускает процессы: подъёмом занимается
// workspace-run.mjs, а плагин (lib/index.js) только читает состояние и решает,
// когда его запустить. Так все функции здесь можно тестировать на временных
// каталогах и с подменёнными зависимостями.
//
// Схема `build/` повторяет проверенную opencode-раскладку, поэтому окружение,
// поднятое opencode в том же worktree, плагин принимает как готовое.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, connect } from 'node:net';
import path from 'node:path';

import { DEFAULTS } from './schema.mjs';

/** Корень окружения внутри worktree. */
export const BUILD_DIR = 'build';

/** Имена файлов состояния внутри `<root>/build`. */
export const FILE_NAMES = {
  port: 'edt-mcp-port',
  pid: 'edt-mcp.pid',
  ready: 'edt-mcp-ready',
  failed: 'edt-mcp-failed',
  imported: 'edt-imported',
  progress: 'init-progress.json',
  script: 'import.script',
  snapshot: 'workspace.json',
  lock: 'init.lock',
  runLock: 'init-run.lock',
  logs: 'logs',
};

/** Платформы, на которых ищем установленный EDT по умолчанию. */
const EDT_ROOTS = {
  win32: ['C:\\Program Files\\1C\\1CE\\components', 'C:\\Program Files (x86)\\1C\\1CE\\components'],
  linux: ['/opt/1C/1CE/components'],
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

/** Путь файла состояния. */
export const filePath = (buildDir, key) => path.join(buildDir, FILE_NAMES[key]);

/** Путь к prefs MCP-сервера EDT внутри workspace. */
export function prefsPath(buildDir) {
  return path.join(
    buildDir,
    'ws',
    '.metadata',
    '.plugins',
    'org.eclipse.core.runtime',
    '.settings',
    'com.ditrix.edt.mcp.server.prefs',
  );
}

/** Каталог, где EDT хранит зарегистрированные проекты workspace. */
export function registeredProjectsDir(buildDir) {
  return path.join(buildDir, 'ws', '.metadata', '.plugins', 'org.eclipse.core.resources', '.projects');
}

/**
 * Настройки окружения с учётом переменных DSH_1C_EDT_HOME / DSH_1C_EDT_IMPORT.
 * @param raw секция workspace из настроек плагина.
 * @param env окружение процесса.
 */
export function normalizeWorkspaceSettings(raw = {}, env = process.env) {
  const defaults = DEFAULTS.workspace;
  const value = isObject(raw) ? raw : {};
  const pick = (key, fallback) => (value[key] === undefined ? fallback : value[key]);
  const positive = (candidate, fallback) => (Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : fallback);
  const port = (candidate, fallback) =>
    Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535 ? candidate : fallback;

  let importMode = pick('import', defaults.import);
  if (importMode !== true && importMode !== false) importMode = 'auto';
  const envImport = env?.DSH_1C_EDT_IMPORT;
  if (typeof envImport === 'string' && envImport.trim() !== '') {
    const lowered = envImport.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) importMode = true;
    else if (['0', 'false', 'no', 'off'].includes(lowered)) importMode = false;
  }

  const ports = isObject(value.ports) ? value.ports : {};
  const min = port(ports.min, defaults.ports.min);
  const max = port(ports.max, defaults.ports.max);

  return {
    enabled: pick('enabled', defaults.enabled) !== false,
    root: text(value.root) ?? '',
    home: {
      win32: text(value.home?.win32) ?? '',
      linux: text(value.home?.linux) ?? '',
    },
    vm: text(value.vm) ?? '',
    xmxIde: text(value.xmxIde) ?? defaults.xmxIde,
    xmxImport: text(value.xmxImport) ?? defaults.xmxImport,
    import: importMode,
    importTimeout: positive(value.importTimeout, defaults.importTimeout),
    startTimeout: positive(value.startTimeout, defaults.startTimeout),
    projects: Array.isArray(value.projects) ? value.projects.filter((item) => text(item) !== undefined).map((item) => item.trim()) : [],
    ports: min <= max ? { min, max } : { min: Math.min(min, max), max: Math.max(min, max) },
    stopOnSessionEnd: pick('stopOnSessionEnd', defaults.stopOnSessionEnd) !== false,
  };
}

/**
 * Куда поднимать окружение для этой сессии.
 *
 * Автостарт включается только в linked worktree: основной checkout работает
 * с уже запущенным вручную EDT. Если в task space несколько включённых
 * репозиториев, берётся первый (отсортированный) и выдаётся предупреждение;
 * `workspace.root` позволяет выбрать явно.
 */
export function resolveWorkspaceTarget({ cwd, config, repositories = [], env = process.env } = {}) {
  const settings = normalizeWorkspaceSettings(config?.workspace, env);
  if (!settings.enabled) return { state: 'off', reason: 'disabled', settings };
  if (!Array.isArray(repositories) || repositories.length === 0) {
    return {
      state: 'error',
      reason: 'no-repository',
      settings,
      message: 'каталог сессии не является git-репозиторием и не содержит репозиториев первого уровня',
    };
  }

  const worktrees = repositories.filter((repo) => repo?.isWorktree === true && typeof repo.root === 'string');
  if (worktrees.length === 0) return { state: 'off', reason: 'main-checkout', settings };

  const warnings = [];
  const repo = worktrees[0];
  if (worktrees.length > 1) {
    warnings.push(
      `несколько worktree (${worktrees.map((item) => item.root).join(', ')}); выбран ${repo.root}. Укажите workspace.root, чтобы выбрать другой.`,
    );
  }

  const configured = settings.root;
  const root =
    configured === ''
      ? repo.root
      : path.isAbsolute(configured)
        ? path.normalize(configured)
        : path.resolve(repo.root, configured);
  const buildDir = path.join(root, BUILD_DIR);

  return {
    state: 'ok',
    settings,
    repo,
    mainRoot: repo.mainRoot,
    root,
    buildDir,
    wsDir: path.join(buildDir, 'ws'),
    isWorktree: true,
    rootSource: configured === '' ? 'repo' : 'config',
    warnings,
  };
}

// --- проекты EDT ------------------------------------------------------------

/** Есть ли в каталоге Eclipse-проект. */
export function hasProjectFile(dir) {
  try {
    return statSync(path.join(dir, '.project')).isFile();
  } catch {
    return false;
  }
}

const hasWildcard = (segment) => segment.includes('*') || segment.includes('?');

function matchSegment(name, segment) {
  if (!hasWildcard(segment)) return name.toLowerCase() === segment.toLowerCase();
  const pattern = segment
    .split('')
    .map((char) => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${pattern}$`, 'i').test(name);
}

function walkPattern(dir, segments, out) {
  if (segments.length === 0) {
    out.push(dir);
    return;
  }
  const [head, ...rest] = segments;
  if (head === '') {
    walkPattern(dir, rest, out);
    return;
  }
  if (head === '..') {
    walkPattern(path.dirname(dir), rest, out);
    return;
  }
  if (!hasWildcard(head)) {
    const next = path.join(dir, head);
    if (existsSync(next)) walkPattern(next, rest, out);
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !matchSegment(entry.name, head)) continue;
    walkPattern(path.join(dir, entry.name), rest, out);
  }
}

/**
 * Разворачивает шаблон EDT-проекта в каталоги с `.project`.
 * Поддерживает `*`/`?` в любом сегменте и абсолютные пути.
 */
export function expandProjectPattern(root, pattern) {
  const raw = String(pattern ?? '').trim();
  if (raw === '') return [];
  const isAbsolute = path.isAbsolute(raw);
  const absolute = isAbsolute ? path.resolve(raw) : undefined;
  const startDir = isAbsolute ? path.parse(absolute).root : root;
  const relative = isAbsolute ? path.relative(startDir, absolute) : raw;
  const segments = relative.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.');
  const out = [];
  walkPattern(startDir, segments, out);
  return out.filter(hasProjectFile);
}

const dedupePaths = (paths) => {
  const seen = new Set();
  const out = [];
  for (const item of paths) {
    const key = path.resolve(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
};

/**
 * Проекты EDT для импорта: шаблоны из настроек либо автопоиск каталогов
 * с `.project` до трёх уровней (кроме build, node_modules и скрытых).
 */
export function discoverProjects(root, patterns = [], { maxDepth = 3 } = {}) {
  if (Array.isArray(patterns) && patterns.length > 0) {
    const matched = [];
    for (const pattern of patterns) matched.push(...expandProjectPattern(root, pattern));
    return dedupePaths(matched);
  }

  const found = [];
  const queue = [{ dir: path.resolve(root), depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (hasProjectFile(dir)) {
      found.push(dir);
      continue;
    }
    if (depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'build' || entry.name === 'node_modules') continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return [...new Set(found)].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

/** Текст скрипта импорта для `1cedtcli -file`. */
export function importScriptText(projects) {
  const lines = (projects ?? [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => `import --project "${item}"`);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

// --- prefs EDT-MCP ----------------------------------------------------------

/** Дописывает значения в prefs, сохраняя остальные ключи. */
export function mergePrefsText(current, values = {}) {
  const map = new Map();
  for (const line of String(current ?? '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) map.set(line.slice(0, index), line.slice(index + 1));
  }
  for (const [key, value] of Object.entries(values)) map.set(key, String(value));
  let out = 'eclipse.preferences.version=1\n';
  for (const [key, value] of map) {
    if (key === 'eclipse.preferences.version') continue;
    out += `${key}=${value}\n`;
  }
  return out;
}

/** prefs, включающие MCP-сервер EDT на нужном порту при старте. */
export function writePrefs(buildDir, port) {
  const file = prefsPath(buildDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const next = mergePrefsText(current, { mcpServerAutoStart: 'true', mcpServerPort: port });
  atomicWrite(file, next);
  return file;
}

// --- порт -------------------------------------------------------------------

/** Свободен ли порт на loopback. */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Случайный свободный порт из диапазона, не занятый самим плагином.
 * @param range { min, max }
 * @param deps.isFree проверка занятости (для тестов).
 * @param deps.used уже использованные порты.
 */
export async function pickFreePort(range, deps = {}) {
  const probe = deps.isFree ?? isPortFree;
  const used = deps.used ?? new Set();
  const random = deps.random ?? Math.random;
  const min = Number(range?.min);
  const max = Number(range?.max);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    throw new Error(`некорректный диапазон портов: ${range?.min}..${range?.max}`);
  }
  const span = max - min + 1;
  for (let attempt = 0; attempt < span; attempt++) {
    const port = min + Math.floor(random() * span);
    if (used.has(port)) continue;
    if (await probe(port)) return port;
    used.add(port);
  }
  throw new Error(`нет свободного порта в диапазоне ${min}..${max}`);
}

/** Порт, занятый нашим процессом (для проверки готовности). */
export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// --- файлы состояния --------------------------------------------------------

/** Атомарная запись: временный файл рядом и rename. */
export function atomicWrite(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // временный файл мог не создаться — это не мешает исходной ошибке
    }
    throw error;
  }
}

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const readJson = (file) => {
  const content = readText(file);
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
};

/** Порт MCP-сервера EDT или null. */
export function readPort(buildDir) {
  const content = readText(filePath(buildDir, 'port'));
  if (content === undefined) return null;
  const value = Number.parseInt(content.trim(), 10);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
}

export function writePort(buildDir, port) {
  atomicWrite(filePath(buildDir, 'port'), String(port));
}

/** `{ pid, startedAt }` процесса EDT или null. */
export function readPid(buildDir) {
  const value = readJson(filePath(buildDir, 'pid'));
  const pid = Number.parseInt(value?.pid, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, startedAt: typeof value?.startedAt === 'string' ? value.startedAt : undefined };
}

export function writePid(buildDir, pid, now = new Date()) {
  atomicWrite(filePath(buildDir, 'pid'), JSON.stringify({ pid, startedAt: now.toISOString() }));
}

/** Отметка времени из файла-маркера. */
export function readStamp(buildDir, key) {
  return readText(filePath(buildDir, key))?.trim() || undefined;
}

export function writeStamp(buildDir, key, now = new Date()) {
  atomicWrite(filePath(buildDir, key), now.toISOString());
}

export function removeStamp(buildDir, key) {
  try {
    rmSync(filePath(buildDir, key), { force: true });
  } catch {
    // маркера могло не быть
  }
}

/** Что импортировали в workspace: `{ projects, at }` или null. */
export function readImported(buildDir) {
  return readJson(filePath(buildDir, 'imported')) ?? null;
}

export function writeImported(buildDir, projects, now = new Date()) {
  atomicWrite(filePath(buildDir, 'imported'), JSON.stringify({ projects, at: now.toISOString() }));
}

/** Прогресс подъёма: `{ startedAt, edt: { phase, since, updated, detail } }`. */
export function readProgress(buildDir) {
  return readJson(filePath(buildDir, 'progress')) ?? null;
}

export function writeProgress(buildDir, kind, phase, detail) {
  const prev = readProgress(buildDir) ?? { startedAt: new Date().toISOString() };
  const now = new Date().toISOString();
  const was = prev[kind];
  prev[kind] = { phase, since: was?.phase === phase && was.since ? was.since : now, updated: now };
  if (detail !== undefined) prev[kind].detail = detail;
  atomicWrite(filePath(buildDir, 'progress'), `${JSON.stringify(prev, null, 2)}\n`);
}

export function clearProgress(buildDir) {
  for (const file of [filePath(buildDir, 'progress'), `${filePath(buildDir, 'progress')}.tmp`]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // прогресса могло не быть
    }
  }
}

/** Последняя непустая строка файла, обрезанная до maxLen. */
export function tailFile(file, maxLen = 200) {
  const content = readText(file);
  if (content === undefined) return null;
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.length === 0 ? null : lines[lines.length - 1].slice(0, maxLen);
}

/** Снимок настроек окружения — для диагностики и фонового процесса. */
export function buildWorkspaceSnapshot({ root, buildDir, wsDir, mainRoot, settings, projects, now = new Date() }) {
  return {
    version: 1,
    root,
    buildDir,
    wsDir,
    mainRoot,
    createdAt: now.toISOString(),
    settings,
    projects,
  };
}

export function writeWorkspaceSnapshot(buildDir, snapshot) {
  atomicWrite(filePath(buildDir, 'snapshot'), `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function readWorkspaceSnapshot(buildDir) {
  return readJson(filePath(buildDir, 'snapshot'));
}

/**
 * Снимок для конкретного worktree: пути, настройки и найденные проекты EDT.
 * Пишется один раз перед подъёмом; фоновый процесс читает его, а не настройки
 * плагина — так окружение поднимается ровно по тому, что было в момент старта.
 */
export function prepareWorkspaceSnapshot({ root, mainRoot, settings, patterns, now = new Date() }) {
  const buildDir = path.join(root, BUILD_DIR);
  const projects = discoverProjects(root, patterns ?? settings?.projects ?? []);
  return buildWorkspaceSnapshot({
    root,
    buildDir,
    wsDir: path.join(buildDir, 'ws'),
    mainRoot,
    settings,
    projects,
    now,
  });
}

// --- процессы ---------------------------------------------------------------

/** Имя образа процесса на Windows (`1cedt.exe`) или null. */
export function parseTasklistImage(output) {
  const line = String(output ?? '')
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith('"'));
  if (line === undefined) return null;
  const match = /^"([^"]+)"/.exec(line);
  return match ? match[1].toLowerCase() : null;
}

export function processImage(pid, { platform = process.platform, run = execFileSync } = {}) {
  try {
    if (platform === 'win32') {
      const output = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return parseTasklistImage(output);
    }
    return path.basename(readlinkSync(`/proc/${pid}/exe`)).toLowerCase();
  } catch {
    return null;
  }
}

/** Жив ли процесс; при указании образов — того ли он типа. */
export function pidAlive(pid, images = null, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!Array.isArray(images) || images.length === 0) return true;
  const image = (deps.processImage ?? processImage)(pid, deps);
  if (!image) return true;
  return images.some((candidate) => image.includes(String(candidate).toLowerCase()));
}

/** Останавливает дерево процессов: сначала мягко, потом принудительно. */
export function killTree(pid, { force = false, platform = process.platform, run = execFileSync, kill = process.kill } = {}) {
  try {
    if (platform === 'win32') {
      const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
      run('taskkill', args, { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      }
    }
  } catch {
    // процесс уже мог завершиться
  }
}

// --- установка EDT ----------------------------------------------------------

/** Установлен ли в этой EDT плагин EDT-MCP (эвристика по именам бандлов). */
export function hasMcpBundle(home) {
  for (const dir of ['plugins', 'features']) {
    let entries;
    try {
      entries = readdirSync(path.join(home, dir));
    } catch {
      continue;
    }
    if (entries.some((name) => /mcp/i.test(name) || /ditrix/i.test(name))) return true;
  }
  return false;
}

const VERSION_PATTERN = /^1c-edt-(\d{4})\.(\d+)\.(\d+)\+(\d+)-/;

/** Версия установки EDT для сортировки (null — не установка EDT). */
export function edtVersionOf(name) {
  const match = VERSION_PATTERN.exec(String(name ?? ''));
  if (match === null) return null;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

const compareVersion = (left, right) => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * Установка EDT: явная из настроек/`DSH_1C_EDT_HOME` либо старшая найденная.
 * @returns {{ home?: string, bin?: string, cli?: string, mcpBundle?: boolean, source?: string, error?: string }}
 */
export function detectEdtHome(settings, { platform = process.platform, env = process.env, roots } = {}) {
  const binary = platform === 'win32' ? '1cedt.exe' : '1cedt';
  const cli = platform === 'win32' ? '1cedtcli.exe' : '1cedtcli';
  const explicit = text(env?.DSH_1C_EDT_HOME) ?? text(settings?.home?.[platform]);
  if (explicit !== undefined) {
    const home = path.normalize(explicit);
    const bin = path.join(home, binary);
    if (!existsSync(bin)) return { error: `в ${home} нет ${binary}`, home };
    return { home, bin, cli: path.join(home, cli), mcpBundle: hasMcpBundle(home), source: text(env?.DSH_1C_EDT_HOME) ? 'env' : 'config' };
  }

  const searchRoots = roots ?? EDT_ROOTS[platform] ?? [];
  const candidates = [];
  for (const root of searchRoots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const version = edtVersionOf(entry.name);
      if (version === null) continue;
      const home = path.join(root, entry.name);
      if (!existsSync(path.join(home, binary))) continue;
      candidates.push({ home, version, mcpBundle: hasMcpBundle(home) });
    }
  }
  if (candidates.length === 0) {
    return { error: `1C:EDT не найден; задайте workspace.home или DSH_1C_EDT_HOME (искали в ${searchRoots.join(', ')})` };
  }
  candidates.sort((left, right) => compareVersion(right.version, left.version));
  const chosen = candidates.find((candidate) => candidate.mcpBundle) ?? candidates[0];
  return {
    home: chosen.home,
    bin: path.join(chosen.home, binary),
    cli: path.join(chosen.home, cli),
    mcpBundle: chosen.mcpBundle,
    source: 'autodetect',
  };
}

/** Java для EDT: явная настройка, env либо jdk-full-17 рядом с установкой. */
export function resolveEdtVm(settings, home, { platform = process.platform, env = process.env } = {}) {
  const explicit = text(env?.DSH_1C_EDT_VM) ?? text(settings?.vm);
  if (explicit !== undefined) return explicit;
  if (typeof home !== 'string' || home === '') return undefined;
  const javaBinary = platform === 'win32' ? 'javaw.exe' : 'java';
  try {
    const components = path.dirname(home);
    const jdk = readdirSync(components, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /jdk-full-17/.test(entry.name))
      .map((entry) => path.join(components, entry.name, 'bin', javaBinary))
      .filter((candidate) => existsSync(candidate))
      .sort();
    return jdk[0];
  } catch {
    return undefined;
  }
}

/** Аргументы запуска EDT GUI с отдельным workspace. */
export function guiArgs({ wsDir, xmx, vm }) {
  const args = ['-nosplash', '-data', wsDir, '--launcher.appendVmargs'];
  if (typeof vm === 'string' && vm !== '') args.push('-vm', vm);
  args.push('-vmargs', `-Xmx${xmx}`);
  return args;
}

/** Аргументы `1cedtcli` для импорта проектов. */
export function importArgs({ wsDir, timeout, xmxImport }, scriptPath) {
  return ['-data', wsDir, '-timeout', String(timeout), '-vmargs', `-Xmx${xmxImport}`, '-file', scriptPath];
}

/** Адрес проверки готовности EDT-MCP (не требует токена). */
export function healthUrl(port) {
  return `http://127.0.0.1:${port}/health`;
}

/** Отвечает ли MCP-сервер EDT на health-запрос. */
export async function probeHealth(port, deps = {}) {
  if (!Number.isInteger(port) || port <= 0) return false;
  const implementation = deps.fetchImpl ?? globalThis.fetch;
  if (typeof implementation !== 'function') return false;
  try {
    const response = await implementation(healthUrl(port), { signal: AbortSignal.timeout(deps.timeoutMs ?? 3000) });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

// --- состояние --------------------------------------------------------------

/**
 * Состояние окружения по файлам. Живость процесса проверяется только когда
 * передан `alive` (по умолчанию — настоящая проверка pid).
 * @returns {{ exists: boolean, label: string, port: number|null, pid: object|null, ready: boolean,
 *             failed: boolean, imported: object|null, progress: object|null }}
 */
export function stateOf(buildDir, deps = {}) {
  const alive = deps.alive ?? ((pid) => pidAlive(pid, ['1cedt']));
  const exists = existsSync(buildDir);
  const port = readPort(buildDir);
  const pid = readPid(buildDir);
  const ready = existsSync(filePath(buildDir, 'ready'));
  const failed = existsSync(filePath(buildDir, 'failed'));
  const imported = readImported(buildDir);
  const progress = readProgress(buildDir);
  const running = pid !== null && alive(pid.pid);

  let label;
  if (!exists) label = 'absent';
  else if (failed) label = 'failed';
  else if (ready) label = running ? 'ready' : 'stale';
  else if (running) label = 'starting';
  else if (progress?.edt?.phase === 'failed') label = 'failed';
  else if (progress?.edt?.phase !== undefined && !['failed', 'ready'].includes(progress.edt.phase)) label = 'starting';
  else label = 'stopped';

  return { exists, label, port, pid, ready, failed, imported, progress };
}

/** Человеческая длительность от ISO-момента. */
export function formatElapsed(sinceIso, nowMs = Date.now()) {
  const started = Date.parse(String(sinceIso ?? ''));
  if (Number.isNaN(started)) return '?';
  const seconds = Math.max(0, Math.round((nowMs - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}
