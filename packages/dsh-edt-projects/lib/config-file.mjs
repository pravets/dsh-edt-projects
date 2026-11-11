// Создание и обновление файла настроек dsh-1c.json.
//
// Существующие значения не перезаписываются: init отказывается работать при
// наличии файла, upgrade только дописывает недостающие ключи. Запись атомарная.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { DEFAULTS, planUpgrade, stringifyConfig, validateConfig } from './schema.mjs';

/** Читает файл настроек; отсутствие — не ошибка. */
export function readExisting(path) {
  if (!existsSync(path)) return { exists: false };
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return { exists: true, error: `${path}: ожидался JSON-объект` };
    }
    return { exists: true, config };
  } catch (error) {
    return { exists: true, error: `${path}: ${error.message}` };
  }
}

/** Атомарная запись: временный файл рядом, затем rename. */
export function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Создаёт файл со значениями по умолчанию.
 * @returns {{ status: 'created'|'exists'|'error', path: string, keys?: string[], error?: string }}
 */
export function initFile(path) {
  const existing = readExisting(path);
  if (existing.error !== undefined) return { status: 'error', path, error: existing.error };
  if (existing.exists) return { status: 'exists', path };

  writeAtomic(path, stringifyConfig(DEFAULTS));
  return { status: 'created', path, keys: Object.keys(DEFAULTS) };
}

/**
 * Дописывает недостающие ключи. При `dryRun` файл не трогается.
 * @returns {{ status: 'updated'|'noop'|'error'|'dry-run', path: string,
 *             added: string[], removed: string[], warnings: string[], errors: string[], config?: object, error?: string }}
 */
export function upgradeFile(path, { dryRun = false } = {}) {
  const existing = readExisting(path);
  if (existing.error !== undefined) {
    return { status: 'error', path, error: existing.error, added: [], removed: [], warnings: [], errors: [] };
  }

  const base = existing.exists ? existing.config : {};
  const plan = planUpgrade(base);
  const { errors, warnings } = validateConfig(plan.config);

  const result = {
    path,
    added: plan.added,
    removed: plan.removed,
    warnings,
    errors,
    config: plan.config,
    version: plan.version,
  };
  if (plan.added.length === 0 && plan.removed.length === 0) return { status: 'noop', ...result };
  if (dryRun) return { status: 'dry-run', ...result };

  writeAtomic(path, stringifyConfig(plan.config));
  return { status: 'updated', ...result };
}
