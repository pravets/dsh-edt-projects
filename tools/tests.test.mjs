// Тесты нормализации флагов тестовой обвязки проекта.
import test from 'node:test';
import assert from 'node:assert/strict';

import { hasTestTooling, normalizeTestTooling } from '../packages/dsh-edt-projects/lib/tests.mjs';

test('сокращённая форма: true включает, false и отсутствие выключают', () => {
  const on = normalizeTestTooling({ yaxunit: true, vanessa: false });
  assert.deepEqual(on.yaxunit, { enabled: true });
  assert.deepEqual(on.vanessa, { enabled: false });

  const empty = normalizeTestTooling({});
  assert.equal(empty.yaxunit.enabled, false);
  assert.equal(empty.vanessa.enabled, false);
});

test('объект: enabled, path и project сохраняются', () => {
  const result = normalizeTestTooling({
    yaxunit: { enabled: true, path: 'tests/yaxunit', project: 'cfe_yaxunit' },
    vanessa: { enabled: true, path: 'features' },
  });
  assert.deepEqual(result.yaxunit, { enabled: true, path: 'tests/yaxunit', project: 'cfe_yaxunit' });
  assert.deepEqual(result.vanessa, { enabled: true, path: 'features' });
});

test('объект без enabled считается выключенным, но подсказки сохраняются', () => {
  const result = normalizeTestTooling({ yaxunit: { path: 'tests/yaxunit', project: 'cfe_yaxunit' } });
  assert.equal(result.yaxunit.enabled, false);
  assert.equal(result.yaxunit.path, 'tests/yaxunit');
  assert.equal(result.yaxunit.project, 'cfe_yaxunit');
});

test('мусор в конфиге не ломает разбор', () => {
  for (const value of ['yes', 42, [], null, undefined, { enabled: 'true' }]) {
    const result = normalizeTestTooling({ yaxunit: value, vanessa: value });
    assert.equal(result.yaxunit.enabled, false);
    assert.equal(result.vanessa.enabled, false);
  }
  assert.equal(normalizeTestTooling(undefined).yaxunit.enabled, false);
  assert.equal(normalizeTestTooling('tests').vanessa.enabled, false);
});

test('пустые строки в path и project не попадают в результат', () => {
  const result = normalizeTestTooling({ yaxunit: { enabled: true, path: '', project: '' } });
  assert.deepEqual(result.yaxunit, { enabled: true });
});

test('hasTestTooling: true, если включён хотя бы один', () => {
  assert.equal(hasTestTooling({ yaxunit: true }), true);
  assert.equal(hasTestTooling({ vanessa: { enabled: true } }), true);
  assert.equal(hasTestTooling({ yaxunit: false, vanessa: false }), false);
  assert.equal(hasTestTooling({}), false);
});
