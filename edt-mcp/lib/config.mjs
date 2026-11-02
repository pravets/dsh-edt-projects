// Слои настроек бандла: база из патча, пользовательский файл и файл проекта.
//
// Приоритет: проект > пользователь > база. Файлы перечитываются на каждый
// mcp_pin/mcp_reload и на каждый рендер промпта, поэтому правки применяются
// без перезапуска DSH; разбор кэшируется по mtimeMs.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USER_FILE = 'dsh-1c.json';
const PROJECT_FILE = '.dsh-1c.json';

/** Кэш разобранных файлов: путь -> { mtimeMs, config, error }. */
const cache = new Map();

/** Путь к пользовательскому файлу настроек ($DSH_HOME/dsh-1c.json). */
export function userConfigPath(env = process.env) {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), USER_FILE);
}

/** Путь к файлу настроек проекта (<cwd>/.dsh-1c.json). */
export function projectConfigPath(cwd) {
  return cwd === undefined || cwd === '' ? undefined : join(cwd, PROJECT_FILE);
}

/**
 * Читает JSON-файл настроек. Отсутствие файла — норма (`config: undefined`),
 * битый JSON — `error`, чтобы вызывающий мог предупредить и взять слой ниже.
 */
export function readJsonConfig(path) {
  if (path === undefined) return { config: undefined };
  let stat;
  try {
    stat = statSync(path);
  } catch {
    cache.delete(path);
    return { config: undefined };
  }
  const hit = cache.get(path);
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs) return hit;

  const entry = { mtimeMs: stat.mtimeMs, config: undefined, error: undefined };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      entry.error = `${path}: ожидался JSON-объект`;
    } else {
      entry.config = parsed;
    }
  } catch (error) {
    entry.error = `${path}: ${error.message}`;
  }
  cache.set(path, entry);
  return entry;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Глубокое слияние: массивы заменяются целиком, объекты сливаются по полям. */
export function mergeLayers(...layers) {
  const result = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = mergeLayers(result[key], value);
      } else if (value !== undefined) {
        result[key] = isPlainObject(value) ? mergeLayers(value) : value;
      }
    }
  }
  return result;
}

/**
 * Собирает действующие настройки: база (патч) <- пользователь <- проект.
 * @returns {{ config: object, sources: string[], errors: string[] }}
 */
export function resolveConfig({ cwd, env = process.env, base = {} } = {}) {
  const sources = [];
  const errors = [];

  const user = readJsonConfig(userConfigPath(env));
  if (user.error !== undefined) errors.push(user.error);
  if (user.config !== undefined) sources.push(userConfigPath(env));

  const projectPath = projectConfigPath(cwd);
  const project = readJsonConfig(projectPath);
  if (project.error !== undefined) errors.push(project.error);
  if (project.config !== undefined && projectPath !== undefined) sources.push(projectPath);

  return { config: mergeLayers(base, user.config, project.config), sources, errors };
}

/** Сбрасывает кэш — используется тестами. */
export function clearConfigCache() {
  cache.clear();
}
