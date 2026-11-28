// Тесты хаба: текст правил под разные наборы серверов и преобразование
// конфигурации строки в конфиг @deepseek-ai/dsh-mcp-client.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Config } from '@deepseek-ai/dsh-mcp-client';

import { ALPHA_ONLY_FIELDS, buildRulesText, connectionStateOf, mountConfig, normalizeServers } from '../packages/dsh-edt-projects/lib/index.js';

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
  assert.match(text, /edt_pin/);
  assert.match(text, /root/);
  assert.doesNotMatch(text, /mcp_pin|mcp_unpin|mcp_servers|mcp_reload|mcp_config/);
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

test('имена собственных инструментов — edt_*, без старых mcp_*', () => {
  const text = buildRulesText({}, [server('edt'), server('bsl', 'lazy')]);
  assert.match(text, /`edt_servers`/);
  assert.match(text, /`edt_unpin\(server\)`/);
  assert.doesNotMatch(text, /mcp_pin|mcp_unpin|mcp_servers|mcp_reload|mcp_config/);
});

test('v8std: блок про стандарты и диагностики при настроенном сервере', () => {
  const text = buildRulesText({}, [server('edt'), server('v8std', 'lazy')]);
  assert.match(text, /### Стандарты и ошибки \(v8std\)/);
  assert.match(text, /v8std_explain_diagnostics/);
  assert.match(text, /v8std_get_page/);
  assert.match(text, /v8std_search/);
  assert.match(text, /v8std_explain_snippet/);
  assert.match(text, /mcp__v8std__\*/);
  assert.match(text, /Не выдумывай номера стандартов/);
  assert.match(text, /Подключены по требованию: v8std/);
});

test('v8std: без сервера блока нет, но pin-правила его называют', () => {
  assert.doesNotMatch(buildRulesText({}, [server('edt')]), /v8std/);
  assert.match(buildRulesText({}, [server('edt'), server('bsl', 'lazy')]), /v8std/);
});

test('v8std: по переменной окружения блок тоже появляется', () => {
  assert.match(buildRulesText({ V8STD_MCP_URL: 'http://127.0.0.1:1/mcp' }, []), /### Стандарты и ошибки \(v8std\)/);
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

test('вики: блок появляется с путями и входной точкой', () => {
  const text = buildRulesText({}, [server('edt')], [{ path: 'C:\\git\\dev-llm-wiki', entry: 'C:\\git\\dev-llm-wiki\\wiki\\index.md' }]);
  assert.match(text, /### Вики проекта/);
  assert.match(text, /C:\\git\\dev-llm-wiki/);
  assert.match(text, /wiki\\index\.md/);
  assert.match(text, /только для чтения/);
});

test('вики: без корней блока нет', () => {
  const text = buildRulesText({}, [server('edt')], []);
  assert.doesNotMatch(text, /### Вики проекта/);
});

test('вики: без входной точки подсказка ведёт к AGENTS.md', () => {
  const text = buildRulesText({}, [server('edt')], [{ path: 'C:\\wiki' }]);
  assert.match(text, /AGENTS\.md/);
});

test('тесты: YAxUnit включает блок и называет проект тестов', () => {
  const text = buildRulesText({}, [server('edt')], [], {
    yaxunit: { enabled: true, path: 'tests/yaxunit', project: 'cfe_yaxunit' },
  });
  assert.match(text, /### Тестируемость \(YAxUnit\)/);
  assert.match(text, /tests\/yaxunit/);
  assert.match(text, /cfe_yaxunit/);
  assert.doesNotMatch(text, /### Сценарные тесты/);
});

test('тесты: Vanessa включает блок про сценарии', () => {
  const text = buildRulesText({}, [server('edt')], [], { vanessa: { enabled: true, path: 'features' } });
  assert.match(text, /### Сценарные тесты \(Vanessa Automation\)/);
  assert.match(text, /features/);
  assert.doesNotMatch(text, /### Тестируемость/);
});

test('тесты: без флагов блоков нет', () => {
  const text = buildRulesText({}, [server('edt')], [], { yaxunit: false, vanessa: false });
  assert.doesNotMatch(text, /### Тестируемость/);
  assert.doesNotMatch(text, /### Сценарные тесты/);
});

test('тесты: YAxUnit идёт раньше Vanessa', () => {
  const text = buildRulesText({}, [server('edt')], [], { yaxunit: true, vanessa: true });
  assert.ok(text.indexOf('### Тестируемость') < text.indexOf('### Сценарные тесты'));
});

test('тесты: без project правило не требует конкретного проекта', () => {
  const text = buildRulesText({}, [server('edt')], [], { yaxunit: true });
  assert.doesNotMatch(text, /Тесты пиши в проект/);
});

test('правило правок действует и при недоступном edt: оно про конфигурацию, а не про связь', () => {
  const text = buildRulesText({ EDT_MCP_URL: 'http://127.0.0.1:8765/mcp' }, []);
  assert.match(text, /Правки конфигурации — только через EDT/);
});

test('normalizeServers отбрасывает disabled и выводит транспорт', () => {
  const entries = normalizeServers({
    edt: { url: 'http://127.0.0.1:8765/mcp' },
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

test('connectionStateOf читает current() хендла, а не свойство state', () => {
  const status = connectionStateOf({ current: () => ({ state: 'reconnecting', lastError: 'boom' }) });
  assert.equal(status.state, 'reconnecting');
  assert.equal(status.lastError, 'boom');
  assert.equal(connectionStateOf({ state: 'connected' }), undefined);
  assert.equal(connectionStateOf({ current: () => { throw new Error('x'); } }), undefined);
  assert.equal(connectionStateOf(undefined), undefined);
});

test('mountConfig прокидывает поля mcp-client 0.2.2', () => {
  const config = mountConfig({
    name: 'edt',
    transport: 'streamable-http',
    raw: { url: 'http://x/mcp', startupTimeoutMs: 15000, closeTimeoutMs: 1000, expandTemplates: true },
  });
  assert.equal(config.startupTimeoutMs, 15000);
  assert.equal(config.closeTimeoutMs, 1000);
  assert.equal(config.expandTemplates, true);
});

test('mountConfig прокидывает поля mcp-client 0.2.3', () => {
  const raw = {
    url: 'http://x/mcp',
    toolLoading: 'on-demand',
    catalogDescriptionMaxLength: 120,
    oauth: { clientId: 'edt' },
  };
  const config = mountConfig({ name: 'edt', transport: 'streamable-http', raw });
  for (const key of ALPHA_ONLY_FIELDS) assert.equal(key in config, true, key);
  assert.equal(config.toolLoading, 'on-demand');
  assert.equal(config.catalogDescriptionMaxLength, 120);
  assert.deepEqual(config.oauth, { clientId: 'edt' });
});

test('mountConfig не отдаёт oauth stdio-серверу', () => {
  const config = mountConfig({
    name: 'bsl',
    transport: 'stdio',
    raw: { transport: 'stdio', command: 'java', args: ['-jar', 'x.jar'], oauth: { clientId: 'nope' } },
  });
  assert.equal('oauth' in config, false);
});

test('mountConfig на legacy-хосте вырезает поля mcp-client 0.2.3', () => {
  const raw = { url: 'http://x/mcp', toolLoading: 'on-demand', catalogDescriptionMaxLength: 120, oauth: { clientId: 'edt' } };
  const config = mountConfig({ name: 'edt', transport: 'streamable-http', raw }, { legacy: true });
  for (const key of ['toolLoading', 'catalogDescriptionMaxLength', 'oauth']) {
    assert.equal(key in config, false, key);
  }
  assert.equal(config.url, 'http://x/mcp');
});

test('конфиг mountConfig проходит схему mcp-client rc.5', () => {
  const http = Config(
    mountConfig({
      name: 'edt',
      transport: 'streamable-http',
      raw: { url: 'http://x/mcp', reconnect: { enabled: true }, startupTimeoutMs: 15000 },
    }),
  );
  assert.equal(http.serverName, 'edt');
  assert.equal(http.startupTimeoutMs, 15000);

  const stdio = Config(
    mountConfig({ name: 'bsl', transport: 'stdio', raw: { transport: 'stdio', command: 'java', args: ['-jar', 'x.jar'] } }),
  );
  assert.equal(stdio.transport, 'stdio');
  assert.deepEqual(stdio.args, ['-jar', 'x.jar']);

  // Схема rc.5 не строга: лишние поля она игнорирует, а legacy-вырезание
  // гарантирует, что до конфига они не доедут.
  const entry = { name: 'edt', transport: 'streamable-http', raw: { url: 'http://x/mcp', toolLoading: 'on-demand' } };
  assert.doesNotThrow(() => Config(mountConfig(entry)));
  const legacy = Config(mountConfig(entry, { legacy: true }));
  for (const key of ALPHA_ONLY_FIELDS) assert.equal(key in legacy, false, key);
});

test('окружение worktree: блок про имя workspace и edt_workspace', () => {
  const workspace = {
    state: 'worktree',
    status: 'ready',
    root: 'C:\\git\\wt',
    wsDir: 'C:\\git\\wt\\build\\ws',
    settings: {},
    warnings: [],
  };
  const text = buildRulesText({}, [server('edt')], [], {}, workspace);
  assert.match(text, /### Окружение EDT в worktree/);
  assert.match(text, /C:\\git\\wt\\build\\ws/);
  assert.match(text, /edt_workspace/);
  assert.match(text, /build\/logs/);
  assert.match(text, /mcp__edt__\*/);
});

test('окружение worktree: без управляемого окружения блока нет', () => {
  assert.doesNotMatch(buildRulesText({}, [server('edt')]), /Окружение EDT в worktree/);
  assert.doesNotMatch(
    buildRulesText({}, [server('edt')], [], {}, { state: 'off', reason: 'main-checkout' }),
    /Окружение EDT в worktree/,
  );
  assert.doesNotMatch(
    buildRulesText({}, [server('edt')], [], {}, { state: 'error', message: 'нет EDT' }),
    /Окружение EDT в worktree/,
  );
});
