# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

## [1.3.0] - 2026-11-02

### Добавлено

- BSL LS запускается в гибридном режиме `lsp --mcp`: LSP-инициализация объявляет
  рабочее пространство (`DSH_1C_BSL_LS_ROOT`), MCP открывается по Streamable HTTP
  на том же процессе. Без этого все инструменты падали с
  `File is not part of any registered workspace`: `dsh-mcp-client` не объявляет
  capability `roots`, а BSL LS берёт корни только оттуда.
- Переменные `DSH_1C_BSL_LS_ROOT`, `DSH_1C_BSL_LS_PORT`, `DSH_1C_BSL_LS_MODE`
  (`hybrid` по умолчанию, `stdio` — старый режим без корней).
- Хаб гасит процесс BSL LS при `mcp_unpin` и при выгрузке плагина.

### Изменено

- `resolveBsl` остался для режима `stdio`; по умолчанию используется
  `startBslSupervisor`.
- Проверено на живом сервере: после `mcp_pin("bsl")` `analyze_file` вернул 57
  диагностик по модулю `Catalogs/Организации/ManagerModule.bsl`.

## [1.2.0] - 2026-11-02

### Добавлено

- Автозагрузка BSL Language Server: если `DSH_1C_BSL_LS_JAR` не задан, при первом
  `mcp_pin("bsl")` хаб скачивает fat-jar `bsl-language-server-<версия>-exec.jar`
  из релизов 1c-syntax/bsl-language-server, сверяет `sha256` из GitHub API,
  пишет через `.part` и кэширует.
- Переменные `DSH_1C_BSL_LS_URL`, `DSH_1C_BSL_LS_VERSION`, `DSH_1C_BSL_LS_CACHE`,
  `DSH_1C_BSL_LS_DOWNLOAD`, `DSH_1C_BSL_LS_JAVA`, `DSH_1C_BSL_LS_CWD`,
  `DSH_1C_BSL_MCP_URL` с префиксом `DSH_1C_`, чтобы не пересекаться с окружением
  машины; старые имена `BSL_LS_*` принимаются как запасные.
- Флаг `provision: true` у сервера: параметры запуска добираются на `mcp_pin`.
- `tools/bsl.test.mjs` — 9 тестов: приоритет настроек, выбор ассета, кэш,
  скачивание с проверкой sha256, отказ при запрете скачивания.

### Изменено

- `mcp_servers` показывает BSL LS как `lazy` (а не `unavailable`): сервер можно
  подготовить самому, скачав jar.
- Правила для модели предупреждают, что первый `mcp_pin("bsl")` может скачивать
  ~130 МБ.

## [1.1.0] - 2026-11-02

### Добавлено

- Хаб `mcp-hub` (`edt-mcp/lib/index.js`): бандл сам монтирует серверы, поэтому
  набор инструментов можно менять без перезапуска.
- Подключение по требованию: флаг `lazy: true` у сервера и мета-инструменты
  `mcp_servers` (состояние), `mcp_pin` (смонтировать), `mcp_unpin` (снять).
  Инструменты, подключённые посреди сессии, попадают в следующий запрос модели,
  DSH фиксирует это блоком `tool-addition`.
- Флаг `unavailable: !!js '…'`: сервер виден в правилах, но `mcp_pin` объясняет,
  какой переменной окружения не хватает.
- Правила для модели собираются из состояния серверов: пока сервер не смонтирован
  или не настроен, инструкций по его инструментам в промпте нет — только про `mcp_pin`.
- BSL Language Server по stdio (`BSL_LS_JAR`, `BSL_LS_JAVA`, `BSL_LS_CWD`) или по
  Streamable HTTP (`BSL_MCP_URL`), система задач (`TASKS_MCP_URL`, `TASKS_MCP_TOKEN`),
  EDT (`EDT_MCP_URL`, `EDT_MCP_TOKEN`).
- `tools/stub-mcp-server.mjs` — минимальный MCP-сервер (Streamable HTTP, JSON-RPC
  без SSE) с инструментом `ping`, который отвечает `pong`.
- `tools/smoke-bundle.mjs` — полный прогон бандла: одноразовый `DSH_HOME`,
  установка из `dist/*.tgz` через `dsh plugin add`, проверка композиции профиля,
  живая MCP-сессия с заглушкой (`initialize`, `tools/list`).
- `tools/rules.test.mjs` и `npm test` — правила, `normalizeServers`, `mountConfig`.
- Workflow `smoke.yml` — запуск smoke по расписанию, вручную и на push/PR, которые
  трогают бандл.

### Изменено

- Бандл стал код-бандлом: появились `main`/`exports["."]` и `lib/`.
- `config.servers` в `cordis.patch.yml` заменил строки `@deepseek-ai/dsh-mcp-client`;
  лишние для выбранного транспорта поля отбрасываются при монтировании.
- EDT подключается сразу и синхронно (его инструменты есть в первом запросе),
  BSL LS и система задач — по умолчанию ленивые.
- Бандл зависит от `@deepseek-ai/dsh-mcp-client@0.2.1-rc.5`: версия должна
  совпадать с версией DSH.
- `validate-bundle.mjs` понимает `!!js`-выражения, проверяет точку входа и что
  в хабе есть сервер, подключаемый сразу; `smoke-bundle.mjs` проверяет строку хаба
  и живое подключение EDT.

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
