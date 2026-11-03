// Тесты схемы настроек и операций с файлом: init, upgrade, валидация.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { initFile, readExisting, upgradeFile } from '../edt-mcp/lib/config-file.mjs';
import { CONFIG_VERSION, DEFAULTS, isKnownPath, planUpgrade, stringifyConfig, validateConfig } from '../edt-mcp/lib/schema.mjs';

const base = join(process.cwd(), '.smoke');
mkdirSync(base, { recursive: true });
const tempDir = () => mkdtempSync(join(base, 'schema-test-'));
const fileIn = (dir) => join(dir, '.dsh-1c.json');

test('init создаёт файл со всеми ключами по умолчанию', () => {
  const dir = tempDir();
  const result = initFile(fileIn(dir));
  assert.equal(result.status, 'created');

  const written = JSON.parse(readFileSync(fileIn(dir), 'utf8'));
  assert.equal(written.version, CONFIG_VERSION);
  assert.deepEqual(Object.keys(written).sort(), ['gitlab', 'servers', 'sonar', 'tests', 'version', 'wiki']);
  assert.deepEqual(written.wiki.paths, []);
  assert.equal(written.tests.yaxunit.enabled, false);
});

test('init не перезаписывает существующий файл', () => {
  const dir = tempDir();
  writeFileSync(fileIn(dir), '{"version":1,"wiki":{"paths":["C:\\\\w"]}}', 'utf8');
  const before = readFileSync(fileIn(dir), 'utf8');

  const result = initFile(fileIn(dir));
  assert.equal(result.status, 'exists');
  assert.equal(readFileSync(fileIn(dir), 'utf8'), before);
});

test('upgrade добавляет только недостающие листья', () => {
  const dir = tempDir();
  writeFileSync(fileIn(dir), '{"version":1,"wiki":{"paths":["C:\\\\w"]},"servers":{"edt":{"url":"http://127.0.0.1:9000/mcp"}}}', 'utf8');

  const result = upgradeFile(fileIn(dir));
  assert.equal(result.status, 'updated');
  assert.ok(result.added.includes('wiki.entry'));
  assert.ok(result.added.includes('tests.yaxunit.project'));
  assert.ok(!result.added.includes('servers.bsl'), 'контейнер не должен попадать в список');
  assert.ok(!result.added.includes('wiki.paths'), 'существующий ключ не добавляется');

  const written = JSON.parse(readFileSync(fileIn(dir), 'utf8'));
  assert.deepEqual(written.wiki.paths, ['C:\\w']);
  assert.equal(written.servers.edt.url, 'http://127.0.0.1:9000/mcp');
});

test('upgrade идемпотентен: второй прогон файл не трогает', () => {
  const dir = tempDir();
  writeFileSync(fileIn(dir), '{"version":1}', 'utf8');
  upgradeFile(fileIn(dir));

  const mtime = statSync(fileIn(dir)).mtimeMs;
  const second = upgradeFile(fileIn(dir));
  assert.equal(second.status, 'noop');
  assert.deepEqual(second.added, []);
  assert.equal(statSync(fileIn(dir)).mtimeMs, mtime);
});

test('upgrade сохраняет неизвестные ключи и предупреждает о них', () => {
  const dir = tempDir();
  writeFileSync(fileIn(dir), '{"version":1,"wiki":{"paths":[],"custom":"x"},"моё":true}', 'utf8');

  const result = upgradeFile(fileIn(dir));
  const written = JSON.parse(readFileSync(fileIn(dir), 'utf8'));
  assert.equal(written.wiki.custom, 'x');
  assert.equal(written['моё'], true);
  assert.ok(result.warnings.some((line) => line.includes('wiki.custom')));
  assert.ok(result.warnings.some((line) => line.includes('моё')));
});

test('битый JSON: отказ и файл байт-в-байт прежний', () => {
  const dir = tempDir();
  const broken = '{ это не json';
  writeFileSync(fileIn(dir), broken, 'utf8');

  const result = upgradeFile(fileIn(dir));
  assert.equal(result.status, 'error');
  assert.match(result.error, /\.dsh-1c\.json/);
  assert.equal(readFileSync(fileIn(dir), 'utf8'), broken);
});

test('dry-run не пишет файл', () => {
  const dir = tempDir();
  writeFileSync(fileIn(dir), '{"version":1}', 'utf8');
  const before = readFileSync(fileIn(dir), 'utf8');

  const result = upgradeFile(fileIn(dir), { dryRun: true });
  assert.equal(result.status, 'dry-run');
  assert.ok(result.added.length > 0);
  assert.equal(readFileSync(fileIn(dir), 'utf8'), before);
});

test('после записи не остаётся временного файла', () => {
  const dir = tempDir();
  upgradeFile(fileIn(dir));
  assert.deepEqual(readdirSync(dir), ['.dsh-1c.json']);
  assert.equal(existsSync(`${fileIn(dir)}.tmp`), false);
});

test('readExisting различает отсутствие, объект и массив', () => {
  const dir = tempDir();
  assert.equal(readExisting(fileIn(dir)).exists, false);

  writeFileSync(fileIn(dir), '[]', 'utf8');
  assert.match(readExisting(fileIn(dir)).error, /JSON-объект/);
});

test('planUpgrade поднимает версию и сообщает об этом', () => {
  const plan = planUpgrade({ version: 0, wiki: { paths: [] } });
  assert.equal(plan.version.from, 0);
  assert.equal(plan.version.to, CONFIG_VERSION);
  assert.equal(plan.config.version, CONFIG_VERSION);
});

test('planUpgrade не меняет существующие значения', () => {
  const plan = planUpgrade({ version: 1, wiki: { paths: ['a', 'b'], entry: 'x.md' }, tests: { yaxunit: { enabled: true, project: 'cfe_yaxunit' } } });
  assert.deepEqual(plan.config.wiki.paths, ['a', 'b']);
  assert.equal(plan.config.wiki.entry, 'x.md');
  assert.equal(plan.config.tests.yaxunit.enabled, true);
  assert.equal(plan.config.tests.yaxunit.project, 'cfe_yaxunit');
});

test('валидация: ошибки типов и предупреждения о неизвестных ключах', () => {
  const bad = validateConfig({ version: 1, wiki: { paths: 'C:\\w' }, tests: { yaxunit: { enabled: 'yes' } }, mystery: 1 });
  assert.ok(bad.errors.some((line) => line.includes('wiki.paths')));
  assert.ok(bad.errors.some((line) => line.includes('tests.yaxunit.enabled')));
  assert.ok(bad.warnings.some((line) => line.includes('mystery')));

  const good = validateConfig(DEFAULTS);
  assert.deepEqual(good.errors, []);
});

test('isKnownPath понимает шаблоны с *', () => {
  assert.equal(isKnownPath('servers.edt.url'), true);
  assert.equal(isKnownPath('servers.any-name.headers'), true);
  assert.equal(isKnownPath('servers.bsl.jar'), true);
  assert.equal(isKnownPath('servers.edt.unknown'), false);
});

test('stringifyConfig: отступ 2 и перевод строки в конце', () => {
  const text = stringifyConfig({ a: 1 });
  assert.equal(text, '{\n  "a": 1\n}\n');
});

test('порядок ключей стабилен: известные по схеме, затем прочие', () => {
  const plan = planUpgrade({ zzz: 1, tests: { vanessa: { enabled: true } }, wiki: { paths: ['a'] } });
  assert.deepEqual(Object.keys(plan.config), ['version', 'wiki', 'servers', 'tests', 'sonar', 'gitlab', 'zzz']);
});

test('sonar и gitlab: ключи в схеме, дефолты выключены, upgrade их добавляет', () => {
  assert.deepEqual(DEFAULTS.sonar, { enabled: false, projectKey: '' });
  assert.deepEqual(DEFAULTS.gitlab, { enabled: false });
  assert.equal(isKnownPath('sonar.enabled'), true);
  assert.equal(isKnownPath('sonar.projectKey'), true);
  assert.equal(isKnownPath('gitlab.enabled'), true);

  const plan = planUpgrade({ version: CONFIG_VERSION });
  assert.ok(plan.added.includes('sonar.enabled'));
  assert.ok(plan.added.includes('gitlab.enabled'));

  const kept = planUpgrade({ version: CONFIG_VERSION, sonar: { enabled: true, projectKey: 'demo' } });
  assert.equal(kept.config.sonar.enabled, true);
  assert.equal(kept.config.sonar.projectKey, 'demo');
});
