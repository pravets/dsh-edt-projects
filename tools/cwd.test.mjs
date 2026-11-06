// Тесты выбора каталога проекта: исходный каталог сессии главнее текущего.
//
// `session.header.cwd` неизменяем (каталог создания сессии), поэтому `cd`
// внутри сессии не должен переключать `.dsh-1c.json`, корень BSL и пути вики.
// Текущий каталог из сервиса `workingDirectory` — только запасной путь.
import test from 'node:test';
import assert from 'node:assert/strict';

import { inject, sessionCwd } from '../edt-mcp/lib/index.js';

const agentWith = (header) => ({ session: { header } });

/** Сервис каталога, запоминающий вызовы. */
const service = (value) => {
  const calls = [];
  return {
    calls,
    get(session) {
      calls.push(session);
      if (value instanceof Error) throw value;
      return value;
    },
  };
};

const original = 'C:\\git\\project-a';
const current = 'C:\\git\\project-b';

test('исходный каталог сессии главнее текущего', () => {
  const dir = sessionCwd(agentWith({ cwd: original }), service(current));
  assert.equal(dir, original);
});

test('при записанном исходном каталоге сервис не вызывается', () => {
  // Если порядок перепутают, сервис бросит и тест это заметит.
  const spy = service(new Error('сервис не должен вызываться'));
  assert.equal(sessionCwd(agentWith({ cwd: original }), spy), original);
  assert.deepEqual(spy.calls, []);
});

test('без исходного каталога берётся текущий из сервиса', () => {
  for (const header of [{}, { cwd: undefined }, { cwd: '' }, { cwd: 42 }]) {
    const dir = sessionCwd(agentWith(header), service(current));
    assert.equal(dir, current, `header=${JSON.stringify(header)}`);
  }
});

test('без сессии — каталог процесса', () => {
  assert.equal(sessionCwd(undefined, service(current)), process.cwd());
  assert.equal(sessionCwd({}, service(current)), process.cwd());
  assert.equal(sessionCwd(agentWith({}), undefined), process.cwd());
});

test('исключение сервиса не роняет плагин', () => {
  const dir = sessionCwd(agentWith({}), service(new Error('сервис недоступен')));
  assert.equal(dir, process.cwd());
});

test('пустое значение сервиса — каталог процесса', () => {
  assert.equal(sessionCwd(agentWith({}), service(undefined)), process.cwd());
  assert.equal(sessionCwd(agentWith({}), service('')), process.cwd());
});

test('workingDirectory объявлен в inject', () => {
  // Сервис читается в sessionCwd, поэтому cordis обязан его внедрить.
  assert.ok(inject.includes('tools'));
  assert.ok(inject.includes('workingDirectory'));
});
