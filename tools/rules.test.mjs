// Тесты хаба: текст правил под разные наборы серверов и преобразование
// конфигурации строки в конфиг @deepseek-ai/dsh-mcp-client.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRulesText, mountConfig, normalizeServers } from '../edt-mcp/lib/index.js';

const server = (name, state = 'mounted') => ({ name, state });

test('без серверов в промпте нет инструкций по ним', () => {
  const text = buildRulesText({}, []);
  assert.match(text, /Работа с 1С через MCP/);
  assert.doesNotMatch(text, /bsl__\*/);
  assert.doesNotMatch(text, /tasks__\*/);
});

test('edt описывается, когда он настроен', () => {
  assert.match(buildRulesText({}, [server('edt')]), /edt__\*/);
});

test('bsl описывается, когда сервер настроен даже ленивым', () => {
  const text = buildRulesText({}, [server('edt'), server('bsl', 'lazy')]);
  assert.match(text, /bsl__\*/);
  assert.match(text, /Подключены по требованию: bsl/);
  assert.match(text, /mcp_pin/);
  assert.match(text, /root/);
});

test('недоступный сервер не описывается как рабочий, но назван', () => {
  const text = buildRulesText({}, [server('edt'), server('tasks', 'unavailable')]);
  assert.doesNotMatch(text, /tasks__\*/);
  assert.match(text, /Настроены не полностью.*tasks/);
});

test('всё настроенное и смонтированное — без блока про pin', () => {
  const text = buildRulesText({}, [server('edt'), server('bsl')]);
  assert.doesNotMatch(text, /Подключены по требованию/);
});

test('правки 1С идут через EDT, с процедурой эскалации', () => {
  const text = buildRulesText({}, [server('edt')]);
  assert.match(text, /Правки конфигурации — только через EDT/);
  assert.match(text, /write_module_source/);
  assert.match(text, /create_metadata/);
  assert.match(text, /https:\/\/github\.com\/DitriXNew\/EDT-MCP\/issues/);
  assert.match(text, /явному разрешению пользователя/);
});

test('без edt правила правок нет', () => {
  const text = buildRulesText({}, []);
  assert.doesNotMatch(text, /write_module_source/);
  assert.doesNotMatch(text, /EDT-MCP\/issues/);
});

test('правило правок действует и при недоступном edt: оно про конфигурацию, а не про связь', () => {
  const text = buildRulesText({ EDT_MCP_URL: 'http://127.0.0.1:8767/mcp' }, []);
  assert.match(text, /Правки конфигурации — только через EDT/);
});

test('normalizeServers отбрасывает disabled и выводит транспорт', () => {
  const entries = normalizeServers({
    edt: { url: 'http://127.0.0.1:8767/mcp' },
    bsl: { transport: 'stdio', command: 'java', lazy: true },
    tasks: { url: 'http://x/mcp', disabled: true },
  });
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.transport, entry.lazy]),
    [
      ['edt', 'streamable-http', false],
      ['bsl', 'stdio', true],
    ],
  );
});

test('mountConfig для stdio не тащит url и headers', () => {
  const config = mountConfig({
    name: 'bsl',
    transport: 'stdio',
    raw: { transport: 'stdio', command: 'java', args: ['-jar', 'x.jar', 'mcp'], url: 'http://stale/mcp', headers: {}, toolCallTimeoutMs: 1000 },
  });
  assert.equal(config.serverName, 'bsl');
  assert.equal(config.transport, 'stdio');
  assert.deepEqual(config.args, ['-jar', 'x.jar', 'mcp']);
  assert.equal('url' in config, false);
  assert.equal('headers' in config, false);
  assert.equal(config.toolCallTimeoutMs, 1000);
});

test('mountConfig для http не тащит command и cwd', () => {
  const config = mountConfig({
    name: 'tasks',
    transport: 'streamable-http',
    raw: { transport: 'streamable-http', url: 'http://tracker/mcp', headers: { Authorization: 'Bearer x' }, command: 'java', cwd: '/tmp' },
  });
  assert.equal(config.transport, 'streamable-http');
  assert.equal(config.url, 'http://tracker/mcp');
  assert.deepEqual(config.headers, { Authorization: 'Bearer x' });
  assert.equal('command' in config, false);
  assert.equal('cwd' in config, false);
});

test('mountConfig не оставляет undefined-поля', () => {
  const config = mountConfig({ name: 'edt', transport: 'streamable-http', raw: { url: 'http://x/mcp' } });
  assert.deepEqual(Object.keys(config).sort(), ['serverName', 'transport', 'url']);
});
