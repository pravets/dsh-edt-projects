// Git-репозиторий и worktree по файлам, без вызова git.
//
// Нужно это для двух вещей:
//   - понять, что каталог сессии — linked worktree, и найти его основной checkout;
//   - увидеть репозитории task space, когда каталог сессии сам репозиторием не
//     является (layout `<task>/<repo>` у dsh-worktree-space).
//
// Git-команды здесь не используются намеренно: функция вызывается при рендере
// промпта (синхронно, на каждом шаге) и должна быть дешёвой и предсказуемой.
// Формат `.git`-файла и `commondir` — стабильный контракт git для linked worktree.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { normalizeProjectPath, matchesProject } from './enable.mjs';

/** Сколько родителей просматривать в поисках `.git`. */
const MAX_UP = 8;

/** Каталоги task space, которые заведомо не репозитории. */
const SKIP_CHILDREN = new Set(['build', 'node_modules', 'archived-docs', '.git', '.worktree-space']);

/** realpath, но для отсутствующего пути — сам путь. */
function realOrSelf(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

/** Файл `.git` со строкой `gitdir: <путь>` — так выглядит linked worktree. */
export function gitFileAt(root) {
  const dotGit = path.join(root, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  let text;
  try {
    text = readFileSync(dotGit, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match) return undefined;
  const raw = match[1].trim().replace(/^"(.*)"$/, '$1');
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
}

/**
 * Общий git-каталог для worktree: в `<main>/.git/worktrees/<name>` лежит
 * файл `commondir` (обычно `../..`). Без него каталог считается общим.
 */
export function commonDirOf(gitDir) {
  try {
    const text = readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (text === '') return gitDir;
    return path.resolve(gitDir, text);
  } catch {
    return gitDir;
  }
}

/** Основной checkout по общему git-каталогу (`<main>/.git` -> `<main>`). */
export function mainRootOf(commonDir) {
  return path.basename(commonDir).toLowerCase() === '.git' ? path.dirname(commonDir) : commonDir;
}

/** Совпадают ли пути (нормализация как в настройках проектов). */
export function isSamePath(left, right, options = {}) {
  const a = normalizeProjectPath(left, options);
  const b = normalizeProjectPath(right, options);
  return a !== undefined && a === b;
}

/**
 * Ближайший git-репозиторий для каталога.
 * @returns {{ root: string, gitDir: string, commonDir: string, mainRoot: string, isWorktree: boolean }|undefined}
 */
export function repositoryAt(startDir, { maxUp = MAX_UP, platform = process.platform } = {}) {
  if (typeof startDir !== 'string' || startDir.trim() === '') return undefined;
  let dir = path.resolve(startDir);
  for (let depth = 0; depth <= maxUp; depth++) {
    const gitDirFile = gitFileAt(dir);
    if (gitDirFile !== undefined) {
      const commonDir = realOrSelf(commonDirOf(gitDirFile));
      const root = realOrSelf(dir);
      // Submodule тоже живёт через `.git`-файл, но worktree-ом не является:
      // его общий каталог лежит в `.git/modules/…` основного репозитория.
      const isSubmodule = commonDir.split(/[\\/]+/).includes('modules');
      if (isSubmodule) {
        return { root, gitDir: gitDirFile, commonDir, mainRoot: root, isWorktree: false };
      }
      const mainRoot = realOrSelf(mainRootOf(commonDir));
      return {
        root,
        gitDir: gitDirFile,
        commonDir,
        mainRoot,
        isWorktree: !isSamePath(root, mainRoot, { platform }),
      };
    }
    if (existsSync(path.join(dir, '.git'))) {
      const root = realOrSelf(dir);
      const gitDir = realOrSelf(path.join(dir, '.git'));
      return { root, gitDir, commonDir: gitDir, mainRoot: root, isWorktree: false };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Репозитории каталога сессии: сам репозиторий либо репозитории первого уровня
 * (task space). Сортировка детерминированная — от неё зависит выбор окружения.
 */
export function repositoriesUnder(cwd, { platform = process.platform, maxChildren = 64 } = {}) {
  const direct = repositoryAt(cwd, { platform });
  if (direct !== undefined) return [direct];

  let entries;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries.slice(0, maxChildren)) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_CHILDREN.has(entry.name)) continue;
    const repo = repositoryAt(path.join(cwd, entry.name), { maxUp: 0, platform });
    if (repo !== undefined) found.push(repo);
  }
  return found.sort((left, right) => left.root.localeCompare(right.root, undefined, { sensitivity: 'base' }));
}

/** Уникальные репозитории по нормализованному корню (для `stop-all` и тестов). */
export function uniqueRepositories(repositories, { platform = process.platform } = {}) {
  const seen = new Set();
  const out = [];
  for (const repo of repositories ?? []) {
    const key = normalizeProjectPath(repo.root, { platform });
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
  }
  return out;
}

/**
 * Каталог, от которого плагин считает проект.
 *
 * `origin` — неизменяемый `session.header.cwd`, `work` — эффективный каталог
 * сессии (`ctx.workingDirectory`). Переключаемся на work только если это
 * linked worktree, связанный с исходным репозиторием: `cd` в подкаталог или в
 * чужой репозиторий проект не переключает, а worktree того же репозитория —
 * переключает. Возвращается корень worktree, а не подкаталог, чтобы настройки
 * и окружение не зависели от `cd` внутри него.
 * @returns {string} абсолютный каталог проекта.
 */
export function resolveContextCwd({ origin, work, platform = process.platform } = {}) {
  if (typeof origin !== 'string' || origin === '') {
    return typeof work === 'string' && work !== '' ? work : process.cwd();
  }
  if (typeof work !== 'string' || work === '' || isSamePath(work, origin, { platform })) return origin;

  const workRepo = repositoryAt(work, { platform });
  if (workRepo === undefined || workRepo.isWorktree !== true) return origin;

  const originRepo = repositoryAt(origin, { platform });
  if (originRepo === undefined) return origin;

  const related =
    isSamePath(workRepo.mainRoot, originRepo.root, { platform }) ||
    isSamePath(workRepo.mainRoot, origin, { platform }) ||
    matchesProject(originRepo.root, workRepo.mainRoot, { platform }) ||
    matchesProject(origin, workRepo.mainRoot, { platform });

  return related ? workRepo.root : origin;
}
