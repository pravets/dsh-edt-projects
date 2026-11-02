# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

## [2.0.0] - 2026-11-02

### Добавлено

- Бандл подключает не один сервер, а несколько, и включает их окружением:
  EDT (`EDT_MCP_URL`, по умолчанию `http://127.0.0.1:8767/mcp`), BSL Language Server
  по stdio (`BSL_LS_JAR`, `BSL_LS_JAVA`, `BSL_LS_CWD`) или по Streamable HTTP
  (`BSL_MCP_URL`), система задач (`TASKS_MCP_URL`, `TASKS_MCP_TOKEN`).
- Плагин `mcp-rules` (`edt-mcp/lib/index.js`): публикует в системный промпт секцию
  с правилами выбора инструментов — сразу после секции MCP-серверов. Текст
  собирается под фактически включённые серверы.
- Условное включение строк через `disabled: !!js '…'` и значения из окружения
  через `!!js` в патче.
- `tools/stub-mcp-server.mjs` — минимальный MCP-сервер (Streamable HTTP, JSON-RPC
  без SSE) с инструментом `ping`, который отвечает `pong`.
- `tools/smoke-bundle.mjs` — полный прогон бандла: одноразовый `DSH_HOME`,
  установка из `dist/*.tgz` через `dsh plugin add`, проверка композиции профиля,
  живая MCP-сессия с заглушкой (`initialize`, `tools/list`).
- `tools/rules.test.mjs` и `npm test` — текст правил для разных наборов серверов.
- Workflow `smoke.yml` — запуск smoke по расписанию, вручную и на PR, которые
  трогают бандл.

### Изменено

- Бандл стал код-бандлом: появились `main`/`exports["."]` и `lib/`, поэтому
  мажорная версия 2.0.0. Версия, профиль и имена инструментов EDT не изменились.
- `validate-bundle.mjs` понимает `!!js`-выражения, проверяет точку входа и ловит
  конфликт `serverName` среди всегда включённых строк.
- `smoke-bundle.mjs` проверяет и строку правил, и строку сервера, а адрес
  заглушки при необходимости переопределяет через `EDT_MCP_URL`/`SMOKE_PORT`.

## [1.0.0] - 2026-11-02

### Добавлено

- Бандл `edt-mcp` для DSH: патч композиции вставляет строку
  `@deepseek-ai/dsh-mcp-client` с транспортом Streamable HTTP на
  `http://127.0.0.1:8767/mcp`, таймаутом вызова 900 000 мс, отключённым
  падением при старте и реконнектом до 30 с.
- Локали `en` / `ru` и иконка для карточки плагина.
- `tools/check-edt-mcp.mjs` — проверка связки без установки бандла:
  TCP-проба порта, GET-проверка «кто отвечает», реальная MCP-сессия,
  `get_edt_version` и `list_projects`.
- `tools/validate-bundle.mjs` — проверка манифеста, YAML-патча, паритета
  локалей и иконки; используется в CI.
- GitHub Actions: `ci.yml` (валидация на push/PR) и `release.yml`
  (tarball в GitHub Release по тегу `v*`).
- MIT-лицензия.
