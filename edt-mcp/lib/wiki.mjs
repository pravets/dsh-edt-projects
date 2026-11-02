// Вики проекта: нормализация путей, поиск входной точки и запрет записи.
//
// Вики — это документация, а не конфигурация: читается обычными read/grep/glob,
// а запись отклоняется guard-ом хаба.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Инструменты, которые изменяют файлы: для путей вики они запрещены. */
export const WRITE_TOOLS = new Set(['edit', 'write', 'str_replace_editor', 'apply_patch']);

const ENTRY_CANDIDATES = ['wiki/index.md', 'index.md', 'README.md', 'AGENTS.md'];

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Первая существующая входная точка: подсказка, затем стандартные имена. */
export function findEntry(root, hint) {
  const candidates = [];
  if (typeof hint === 'string' && hint !== '') candidates.push(hint);
  candidates.push(...ENTRY_CANDIDATES);
  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? candidate : join(root, candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * Приводит настройку вики к списку корней.
 * Принимает строку, массив строк или { paths, entry }.
 * Несуществующие каталоги отбрасываются — их перечисляет `missing`.
 */
export function normalizeWiki(wiki, { cwd = process.cwd() } = {}) {
  const raw = typeof wiki === 'string' ? [wiki] : Array.isArray(wiki) ? wiki : wiki?.paths ?? [];
  const hint = typeof wiki === 'object' && !Array.isArray(wiki) ? wiki?.entry : undefined;

  const roots = [];
  const missing = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') continue;
    const path = resolve(cwd, item);
    if (!isDirectory(path)) {
      missing.push(path);
      continue;
    }
    roots.push({ path, entry: findEntry(path, hint) });
  }
  return { roots, missing };
}

/** Сравнение путей с учётом регистра Windows. */
function samePath(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return normalize(left) === normalize(right);
}

/** Лежит ли путь внутри каталога (включая сам каталог). */
export function isInside(target, root) {
  const from = resolve(root);
  const to = resolve(target);
  if (samePath(from, to)) return true;
  const rel = relative(from, to);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
}

/**
 * Причина отказа для инструмента записи или undefined, если запись допустима.
 * Чистая функция: используется и guard-ом, и тестами.
 */
export function writeDenialReason(toolName, targetPath, roots, { cwd = process.cwd() } = {}) {
  if (!WRITE_TOOLS.has(toolName)) return undefined;
  if (typeof targetPath !== 'string' || targetPath === '') return undefined;
  const target = resolve(cwd, targetPath);
  for (const root of roots) {
    const path = typeof root === 'string' ? root : root?.path;
    if (path === undefined) continue;
    if (isInside(target, path)) {
      return `Вики доступна только для чтения: ${target}. Правки вики — отдельная задача; попросите пользователя, если это нужно.`;
    }
  }
  return undefined;
}

/** Путь, который изменяет инструмент записи, если он есть в аргументах. */
export function targetPathOf(exec) {
  const args = exec?.arguments;
  if (args === null || typeof args !== 'object') return undefined;
  for (const key of ['file_path', 'path', 'target', 'file']) {
    if (typeof args[key] === 'string') return args[key];
  }
  return undefined;
}
