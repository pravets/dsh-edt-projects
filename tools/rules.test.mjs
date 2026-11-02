// Проверка текста правил, который бандл отдаёт в системный промпт.
// Условия включения серверов должны совпадать с `disabled` в cordis.patch.yml:
// если сервера нет, модель не должна получать про него инструкции.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRulesText } from '../edt-mcp/lib/index.js';

test('без BSL LS и трекера правил про них нет', () => {
  const text = buildRulesText({});
  assert.match(text, /edt__\*/);
  assert.doesNotMatch(text, /bsl__\*/);
  assert.doesNotMatch(text, /tasks__\*/);
});

test('BSL LS включается путём к jar', () => {
  const text = buildRulesText({ BSL_LS_JAR: 'C:\\tools\\bsl-language-server.jar' });
  assert.match(text, /bsl__\*/);
  assert.match(text, /analyze_file/);
  assert.doesNotMatch(text, /tasks__\*/);
});

test('BSL LS включается адресом уже запущенного сервера', () => {
  const text = buildRulesText({ BSL_MCP_URL: 'http://127.0.0.1:8080/mcp' });
  assert.match(text, /bsl__\*/);
});

test('система задач включается адресом', () => {
  const text = buildRulesText({ TASKS_MCP_URL: 'https://tracker.example/mcp' });
  assert.match(text, /tasks__\*/);
  assert.doesNotMatch(text, /bsl__\*/);
});

test('базовые правила про состояние проекта на месте', () => {
  const text = buildRulesText({});
  assert.match(text, /update_database/);
  assert.match(text, /grep/);
});
