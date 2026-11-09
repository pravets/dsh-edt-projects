// Включён ли плагин для проекта сессии.
//
// Плагин установлен в профиль один раз, но его инструменты, правила, навыки и
// MCP-серверы нужны только там, где работают с 1С. Поэтому активация считается
// от исходного каталога сессии:
//
//   1. `enabled: true`  — включён;
//   2. `enabled: false` — выключен (сильнее файла проекта и списка);
//   3. разбираемый `.dsh-1c.json` в каталоге проекта — включён;
//   4. каталог попадает в `projects` пользовательского файла — включён;
//   5. иначе выключен.
//
// Сравнение путей: абсолютные пути, `~` раскрывается, хвостовой разделитель
// снимается, существующие пути приводятся через realpath; на Windows регистр не
// важен. Совпадение — равенство или вложенность по границе каталога, поэтому
// `C:\git\trade2` не считается проектом `C:\git\trade`.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const implFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * Приводит путь проекта к сравнимому виду.
 * @param value путь из настроек или каталог сессии.
 * @param options.platform платформа для правил путей (по умолчанию текущая).
 * @param options.home домашний каталог для `~`.
 * @returns нормализованный абсолютный путь или undefined, если путь не абсолютный.
 */
export function normalizeProjectPath(value, { platform = process.platform, home = homedir() } = {}) {
  if (typeof value !== 'string') return undefined;
  const impl = implFor(platform);
  let text = value.trim();
  if (text === '') return undefined;

  if (text === '~') text = home;
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = impl.join(home, text.slice(2));

  if (!impl.isAbsolute(text)) return undefined;
  let resolved = impl.normalize(text);

  // realpath имеет смысл только для реальной платформы: путь чужой платформы
  // здесь не существует и был бы искажён.
  if (platform === process.platform) {
    try {
      resolved = realpathSync.native(resolved);
    } catch {
      // Каталога может ещё не быть — сравниваем нормализованный путь.
    }
  }

  // Хвостовой разделитель не должен делать «C:\git\trade\» другим проектом.
  // Корень диска и «/» сохраняются как есть.
  const trimmed = resolved.replace(/[\\/]+$/, '');
  if (trimmed !== '') resolved = trimmed;
  if (platform === 'win32') resolved = resolved.toLowerCase();
  return resolved;
}

/** Совпадает ли каталог с записью списка проектов (сам каталог или его потомок). */
export function matchesProject(cwd, entry, options = {}) {
  const platform = options.platform ?? process.platform;
  const left = normalizeProjectPath(cwd, { ...options, platform });
  const right = normalizeProjectPath(entry, { ...options, platform });
  if (left === undefined || right === undefined) return false;
  if (left === right) return true;
  const impl = implFor(platform);
  const base = right.endsWith(impl.sep) ? right : right + impl.sep;
  return left.startsWith(base);
}

/**
 * Решение об активации вместе с причиной — причина нужна edt_config show.
 * @returns {{ enabled: boolean, reason: string, entry?: string }}
 */
export function activationFor({ cwd, config, hasProjectFile = false } = {}, options = {}) {
  const value = config ?? {};
  if (value.enabled === true) return { enabled: true, reason: 'enabled' };
  if (value.enabled === false) return { enabled: false, reason: 'disabled' };
  if (hasProjectFile) return { enabled: true, reason: 'project-file' };

  const projects = Array.isArray(value.projects) ? value.projects : [];
  const hit = projects.find((entry) => matchesProject(cwd, entry, options));
  if (hit !== undefined) return { enabled: true, reason: 'allowlist', entry: hit };
  return { enabled: false, reason: 'not-selected' };
}

/** Короткая форма activationFor для гейтов в рантайме. */
export function isEnabledFor(input, options = {}) {
  return activationFor(input, options).enabled;
}

/**
 * Активация с учётом путей worktree.
 *
 * Обычная проверка идёт от каталога сессии. Для worktree дополнительно
 * проверяются его корень и основной checkout: запись `projects` может называть
 * основной checkout, а файл `.dsh-1c.json` может лежать только в нём (не
 * закоммичен). Сильнее всего остаётся `enabled` из объединённых настроек.
 * @param input.cwd каталог сессии (может быть корнем task space).
 * @param input.paths дополнительные пути: корень worktree, основной checkout.
 */
export function activationForPaths({ cwd, config, hasProjectFile = false, paths = [] } = {}, options = {}) {
  const direct = activationFor({ cwd, config, hasProjectFile }, options);
  if (direct.reason !== 'not-selected') return direct;

  const projects = Array.isArray(config?.projects) ? config.projects : [];
  const seen = new Set([normalizeProjectPath(cwd, options)]);
  for (const candidate of paths) {
    const key = normalizeProjectPath(candidate, options);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    const entry = projects.find((item) => matchesProject(candidate, item, options));
    if (entry !== undefined) {
      return { enabled: true, reason: 'allowlist', entry, path: candidate, inherited: true };
    }
  }
  return direct;
}
