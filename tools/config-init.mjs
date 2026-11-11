// CLI для файла настроек dsh-1c.json: создать, дополнить, показать.
//
//   node tools/config-init.mjs                # проект: <cwd>/.dsh-1c.json
//   node tools/config-init.mjs --user         # $DSH_HOME/dsh-1c.json
//   node tools/config-init.mjs --dry-run      # показать, что будет добавлено
//   node tools/config-init.mjs --print        # напечатать JSON, не записывая
//   node tools/config-init.mjs --cwd <dir>    # другой каталог проекта
import { resolve } from 'node:path';

import { initFile, readExisting, upgradeFile } from '../packages/dsh-edt-projects/lib/config-file.mjs';
import { projectConfigPath, userConfigPath } from '../packages/dsh-edt-projects/lib/config.mjs';
import { DEFAULTS, planUpgrade, stringifyConfig, validateConfig } from '../packages/dsh-edt-projects/lib/schema.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const cwdIndex = args.indexOf('--cwd');
const cwd = cwdIndex === -1 ? process.cwd() : resolve(args[cwdIndex + 1] ?? process.cwd());
const path = has('--user') ? userConfigPath(process.env) : projectConfigPath(cwd);
const dryRun = has('--dry-run') || has('--print');

if (path === undefined) {
  console.error('не удалось определить путь к файлу настроек');
  process.exit(2);
}

const existing = readExisting(path);
if (existing.error !== undefined) {
  console.error(`ОШИБКА: ${existing.error}`);
  console.error('Файл не изменён. Исправьте JSON вручную и повторите.');
  process.exit(1);
}

const result = existing.exists ? upgradeFile(path, { dryRun }) : null;

if (result === null) {
  // Файла нет: создаём либо показываем, что создали бы.
  if (has('--print') || has('--dry-run')) {
    console.log(`Файл ${path} будет создан со значениями по умолчанию:`);
    console.log(stringifyConfig(DEFAULTS));
    if (has('--dry-run')) console.log('(dry-run: файл не создан)');
    process.exit(0);
  }
  const created = initFile(path);
  if (created.status !== 'created') {
    console.error(`ОШИБКА: ${created.error ?? created.status}`);
    process.exit(1);
  }
  console.log(`Создан ${path}`);
  console.log(`Ключи: ${created.keys.join(', ')}`);
  console.log('Дальше: впишите пути вики, корень конфигурации и флаги тестов.');
  process.exit(0);
}

if (has('--print')) {
  console.log(stringifyConfig(result.config));
  process.exit(0);
}

const changed = result.added.length + (result.removed?.length ?? 0);
if (changed === 0) {
  console.log(`${path}: актуален, добавлять нечего.`);
} else if (result.status === 'dry-run') {
  console.log(`${path}: будет изменено: добавлено ${result.added.length}, убрано ${result.removed?.length ?? 0}`);
  for (const key of result.added) console.log(`  + ${key}`);
  for (const key of result.removed ?? []) console.log(`  - ${key}`);
  console.log('(dry-run: файл не изменён)');
} else if (result.status === 'updated') {
  console.log(`${path}: обновлён, добавлено ${result.added.length}, убрано ${result.removed?.length ?? 0}`);
  for (const key of result.added) console.log(`  + ${key}`);
  for (const key of result.removed ?? []) console.log(`  - ${key}`);
} else {
  console.error(`ОШИБКА: ${result.error ?? result.status}`);
  process.exit(1);
}

for (const warning of result.warnings) console.log(`  ! ${warning}`);
for (const error of result.errors) console.error(`  ✗ ${error}`);

// Проверка, что апгрейд идемпотентен: второй прогон не должен ничего добавлять.
if (result.status === 'updated') {
  const again = planUpgrade(result.config);
  if (again.added.length > 0) console.error(`  ✗ повторный апгрейд снова добавляет: ${again.added.join(', ')}`);
}

const validation = validateConfig(result.config);
if (validation.errors.length > 0) process.exit(1);
