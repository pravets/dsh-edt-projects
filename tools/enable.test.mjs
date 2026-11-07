// Тесты включения плагина по проекту: нормализация путей, границы каталогов,
// приоритет enabled > файл проекта > список projects.
import test from 'node:test';
import assert from 'node:assert/strict';

import { activationFor, isEnabledFor, matchesProject, normalizeProjectPath } from '../packages/dsh-edt-projects/lib/enable.mjs';

const home = 'C:\\Users\\dev';
const win = { platform: 'win32', home };
const posix = { platform: 'posix', home: '/home/dev' };

test('normalizeProjectPath: разделители, регистр на Windows, ~', () => {
  assert.equal(normalizeProjectPath('C:\\git\\trade\\', win), 'c:\\git\\trade');
  assert.equal(normalizeProjectPath('C:\\git\\trade', win), 'c:\\git\\trade');
  assert.equal(normalizeProjectPath('~/trade', win), 'c:\\users\\dev\\trade');
  assert.equal(normalizeProjectPath('/home/dev/trade/', posix), '/home/dev/trade');
  assert.equal(normalizeProjectPath('trade', win), undefined, 'относительный путь не проект');
  assert.equal(normalizeProjectPath(42, win), undefined);
});

test('matchesProject на Windows: сам каталог, потомок, регистр, граница', () => {
  assert.equal(matchesProject('C:\\git\\trade', 'C:\\git\\trade', win), true);
  assert.equal(matchesProject('C:\\git\\trade\\src\\cf', 'C:\\git\\trade', win), true);
  assert.equal(matchesProject('c:\\GIT\\Trade\\src', 'C:\\git\\trade', win), true);
  assert.equal(matchesProject('C:\\git\\trade2', 'C:\\git\\trade', win), false);
  assert.equal(matchesProject('C:\\git\\trade-old', 'C:\\git\\trade', win), false);
  assert.equal(matchesProject('C:\\git\\other', 'C:\\git\\trade', win), false);
});

test('matchesProject на POSIX: регистр важен, граница та же', () => {
  assert.equal(matchesProject('/home/dev/trade/src', '/home/dev/trade', posix), true);
  assert.equal(matchesProject('/home/dev/trade2', '/home/dev/trade', posix), false);
  assert.equal(matchesProject('/Home/dev/trade', '/home/dev/trade', posix), false);
});

test('выключенный проект: ни файла, ни списка', () => {
  const activation = activationFor({ cwd: 'C:\\git\\trade', config: {} }, win);
  assert.equal(activation.enabled, false);
  assert.equal(activation.reason, 'not-selected');
  assert.equal(isEnabledFor({ cwd: 'C:\\git\\trade', config: {} }, win), false);
});

test('enabled: true включает, enabled: false выключает сильнее всего остального', () => {
  assert.equal(activationFor({ cwd: 'C:\\git\\trade', config: { enabled: true } }, win).enabled, true);

  const off = activationFor(
    { cwd: 'C:\\git\\trade', config: { enabled: false, projects: ['C:\\git\\trade'] }, hasProjectFile: true },
    win,
  );
  assert.equal(off.enabled, false);
  assert.equal(off.reason, 'disabled');
});

test('файл проекта включает, даже без списка и enabled', () => {
  const activation = activationFor({ cwd: 'C:\\git\\trade', config: {}, hasProjectFile: true }, win);
  assert.equal(activation.enabled, true);
  assert.equal(activation.reason, 'project-file');
});

test('проект из списка projects включает сам каталог и потомков', () => {
  const config = { projects: ['C:\\git\\trade'] };
  assert.equal(activationFor({ cwd: 'C:\\git\\trade', config }, win).enabled, true);
  assert.equal(activationFor({ cwd: 'C:\\git\\trade\\src', config }, win).enabled, true);
  assert.equal(activationFor({ cwd: 'C:\\git\\trade2', config }, win).enabled, false);

  const viaParent = activationFor({ cwd: 'C:\\git\\trade\\src\\cf', config: { projects: ['C:\\git\\trade'] } }, win);
  assert.equal(viaParent.reason, 'allowlist');
  assert.equal(viaParent.entry, 'C:\\git\\trade');
});

test('projects: ~, мусор в массиве и не-массив игнорируются', () => {
  assert.equal(activationFor({ cwd: 'C:\\Users\\dev\\trade', config: { projects: ['~/trade'] } }, win).enabled, true);
  assert.equal(activationFor({ cwd: 'C:\\git\\trade', config: { projects: [null, 42, 'trade'] } }, win).enabled, false);
  assert.equal(activationFor({ cwd: 'C:\\git\\trade', config: { projects: 'C:\\git\\trade' } }, win).enabled, false);
});

test('проект ищется от исходного каталога: вложенность глубже тоже совпадает', () => {
  const config = { projects: ['/home/dev/trade'] };
  assert.equal(activationFor({ cwd: '/home/dev/trade/src/cf', config }, posix).enabled, true);
  assert.equal(activationFor({ cwd: '/home/dev/trade-copy/src', config }, posix).enabled, false);
});
