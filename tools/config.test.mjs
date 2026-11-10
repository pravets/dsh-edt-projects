// Тесты слоистых настроек: слияние, приоритет, битый JSON, кэш по mtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  clearConfigCache,
  mergeLayers,
  projectConfigLoaded,
  projectConfigPath,
  projectDirs,
  readJsonConfig,
  resolveConfig,
  userConfigPath,
} from '../packages/dsh-edt-projects/lib/config.mjs';

const base = join(process.cwd(), '.smoke');
mkdirSync(base, { recursive: true });
const tempDir = () => mkdtempSync(join(base, 'cfg-test-'));

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value), 'utf8');

test('mergeLayers: объекты сливаются, массивы заменяются', () => {
  const merged = mergeLayers(
    { wiki: { paths: ['a'], entry: 'index.md' }, servers: { edt: { url: 'http://one' } } },
    { wiki: { paths: ['b'] }, servers: { edt: { headers: { A: '1' } }, bsl: { root: 'C:\\cf' } } },
  );
  assert.deepEqual(merged.wiki.paths, ['b']);
  assert.equal(merged.wiki.entry, 'index.md');
  assert.equal(merged.servers.edt.url, 'http://one');
  assert.deepEqual(merged.servers.edt.headers, { A: '1' });
  assert.equal(merged.servers.bsl.root, 'C:\\cf');
});

test('resolveConfig: проект перекрывает пользователя, пользователь — базу', () => {
  clearConfigCache();
  const home = tempDir();
  const project = tempDir();
  writeJson(join(home, 'dsh-1c.json'), { servers: { edt: { url: 'http://user' }, bsl: { root: 'C:\\user' } } });
  writeJson(join(project, '.dsh-1c.json'), { servers: { edt: { url: 'http://project' } } });

  const { config, sources, errors } = resolveConfig({
    cwd: project,
    env: { DSH_HOME: home },
    base: { servers: { edt: { url: 'http://base' }, bsl: { root: 'C:\\base' } } },
  });

  assert.equal(config.servers.edt.url, 'http://project');
  assert.equal(config.servers.bsl.root, 'C:\\user');
  assert.deepEqual(errors, []);
  assert.deepEqual(sources, [join(home, 'dsh-1c.json'), join(project, '.dsh-1c.json')]);
});

test('resolveConfig: файлов нет — работает база', () => {
  clearConfigCache();
  const project = tempDir();
  const { config, sources, errors } = resolveConfig({
    cwd: project,
    env: { DSH_HOME: tempDir() },
    base: { servers: { edt: { url: 'http://base' } } },
  });
  assert.equal(config.servers.edt.url, 'http://base');
  assert.deepEqual(sources, []);
  assert.deepEqual(errors, []);
});

test('битый JSON: ошибка в списке, слой ниже сохраняется', () => {
  clearConfigCache();
  const home = tempDir();
  const project = tempDir();
  writeFileSync(join(project, '.dsh-1c.json'), '{ это не json', 'utf8');
  writeJson(join(home, 'dsh-1c.json'), { servers: { edt: { url: 'http://user' } } });

  const { config, errors } = resolveConfig({ cwd: project, env: { DSH_HOME: home }, base: {} });
  assert.equal(config.servers.edt.url, 'http://user');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\.dsh-1c\.json/);
});

test('массив вместо объекта считается ошибкой', () => {
  clearConfigCache();
  const dir = tempDir();
  writeFileSync(join(dir, 'dsh-1c.json'), '[1,2,3]', 'utf8');
  const result = readJsonConfig(join(dir, 'dsh-1c.json'));
  assert.equal(result.config, undefined);
  assert.match(result.error, /JSON-объект/);
});

test('кэш: тот же mtime — старое значение, новый mtime — перечитано', () => {
  clearConfigCache();
  const dir = tempDir();
  const path = join(dir, 'dsh-1c.json');
  writeJson(path, { marker: 'first' });
  const fixed = new Date('2026-01-01T00:00:00Z');
  utimesSync(path, fixed, fixed);

  assert.equal(readJsonConfig(path).config.marker, 'first');

  writeJson(path, { marker: 'second' });
  utimesSync(path, fixed, fixed);
  assert.equal(readJsonConfig(path).config.marker, 'first', 'при том же mtime значение берётся из кэша');

  const later = new Date('2026-01-02T00:00:00Z');
  utimesSync(path, later, later);
  assert.equal(readJsonConfig(path).config.marker, 'second');
});

test('resolveConfig: projectCwds задаёт слои worktree (main < repo < cwd)', () => {
  clearConfigCache();
  const home = tempDir();
  const main = tempDir();
  const repo = tempDir();
  const cwd = tempDir();
  writeJson(join(home, 'dsh-1c.json'), { servers: { bsl: { root: 'C:\\user' } } });
  writeJson(join(main, '.dsh-1c.json'), { servers: { edt: { url: 'http://main' }, bsl: { root: 'C:\\main' } }, workspace: { xmxIde: '4g' } });
  writeJson(join(repo, '.dsh-1c.json'), { servers: { edt: { url: 'http://repo' } } });
  writeJson(join(cwd, '.dsh-1c.json'), { workspace: { xmxIde: '8g' } });

  const { config, sources, errors } = resolveConfig({
    cwd,
    projectCwds: [main, repo, cwd, repo],
    env: { DSH_HOME: home },
    base: {},
  });

  assert.equal(config.servers.edt.url, 'http://repo', 'файл worktree сильнее main');
  assert.equal(config.servers.bsl.root, 'C:\\main', 'значение из main сохраняется, если ниже его не перекрыли');
  assert.equal(config.workspace.xmxIde, '8g', 'cwd сильнее всех');
  assert.deepEqual(errors, []);
  assert.deepEqual(sources, [join(home, 'dsh-1c.json'), join(main, '.dsh-1c.json'), join(repo, '.dsh-1c.json'), join(cwd, '.dsh-1c.json')]);
});

test('resolveConfig: projectCwds без cwd читает только переданные каталоги', () => {
  clearConfigCache();
  const main = tempDir();
  const cwd = tempDir();
  writeJson(join(main, '.dsh-1c.json'), { enabled: true });
  const { config, sources } = resolveConfig({ cwd, projectCwds: [main], env: { DSH_HOME: tempDir() }, base: {} });
  assert.equal(config.enabled, true);
  assert.deepEqual(sources, [join(main, '.dsh-1c.json')]);
});

test('projectDirs раскрывает cwd по умолчанию и схлопывает дубликаты', () => {
  assert.deepEqual(projectDirs({ cwd: '/wt' }), ['/wt']);
  const dirs = projectDirs({ cwd: '/wt', projectCwds: ['/main', '/wt', '/main/'] });
  assert.deepEqual(dirs, ['/main', '/wt']);
});

test('пути файлов настроек', () => {
  assert.equal(userConfigPath({ DSH_HOME: 'C:\\dsh' }), join('C:\\dsh', 'dsh-1c.json'));
  assert.equal(projectConfigPath('C:\\proj'), join('C:\\proj', '.dsh-1c.json'));
  assert.equal(projectConfigPath(''), undefined);
});

test('projectConfigLoaded: только существующий и разбираемый файл включает проект', () => {
  clearConfigCache();
  const empty = tempDir();
  assert.equal(projectConfigLoaded(empty), false, 'файла нет');
  assert.equal(projectConfigLoaded(undefined), false);

  const valid = tempDir();
  writeJson(join(valid, '.dsh-1c.json'), {});
  assert.equal(projectConfigLoaded(valid), true, 'пустой объект — уже включение');

  const broken = tempDir();
  writeFileSync(join(broken, '.dsh-1c.json'), '{ битый', 'utf8');
  assert.equal(projectConfigLoaded(broken), false, 'битый JSON не включает 1С-режим');

  const array = tempDir();
  writeFileSync(join(array, '.dsh-1c.json'), '[]', 'utf8');
  assert.equal(projectConfigLoaded(array), false, 'массив вместо объекта — тоже ошибка');
});
