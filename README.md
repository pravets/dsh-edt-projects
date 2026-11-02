# dsh-edt-plugin

[![CI](https://github.com/pravets/dsh-edt-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/pravets/dsh-edt-plugin/actions/workflows/ci.yml)

Бандл для DeepSeek Harness: хаб MCP-серверов для работы с конфигурацией 1С —
**1C:EDT** ([DitriXNew/EDT-MCP](https://github.com/DitriXNew/EDT-MCP)),
**BSL Language Server** и, при желании, MCP-сервер системы задач — плюс правила
выбора инструментов в системном промпте.

Инструменты приходят как `mcp__edt__*`, `mcp__bsl__*` и `mcp__tasks__*`.
EDT подключён всегда, BSL LS и трекер — по требованию: `mcp_pin` монтирует сервер,
и его инструменты появляются в следующем же запросе к модели. Так схемы
эпизодических серверов не занимают контекст постоянно.

**Статус:** работает. Сервер `edt-mcp-server` 2.22.1 на `127.0.0.1:8767`, EDT 2026.1.2.2,
бандл установлен в профиль `web`, инструменты доступны как `mcp__edt__*` (99 штук).
BSL LS и трекер подключаются окружением и по `mcp_pin`, когда заданы их адрес или jar.

## Состав

```
edt-mcp/
  package.json           манифест бандла (dsh.bundle.patch, main, зависимости)
  cordis.patch.yml       config.servers: EDT, BSL LS (stdio/http), задачи + lazy
  lib/index.js           хаб mcp-hub: монтаж серверов, mcp_servers/pin/unpin, правила
  lib/bsl.mjs            поиск и автозагрузка jar BSL Language Server (sha256)
  locale/en.json         название и описание для карточки плагина
  locale/ru.json
  icon.svg
tools/
  check-edt-mcp.mjs      проверка сервера без установки бандла
  validate-bundle.mjs    проверка манифеста, патча, локалей и иконки (CI)
  stub-mcp-server.mjs    заглушка MCP-сервера для smoke
  smoke-bundle.mjs       прогон бандла в одноразовом профиле DSH
  rules.test.mjs         тесты правил и преобразования конфигурации серверов
  bsl.test.mjs           тесты автозагрузки BSL LS
.github/workflows/
  ci.yml                 валидация на push и pull request
  release.yml            tarball бандла в GitHub Release по тегу v*
  smoke.yml              полный smoke бандла с настоящим DSH
package.json             рабочее пространство: скрипты и dev-зависимости
```

## Что нужно до установки

1. **EDT-MCP установлен в EDT** (2026.1 / 2026.2): Help → Install New Software →
   `https://ditrixnew.github.io/EDT-MCP/` → EDT MCP Server Feature → перезапуск.
2. **Сервер запущен**: Window → Preferences → MCP Server → Server Port и Start/автостарт.
   Порт по умолчанию у EDT-MCP — `8765`. На машине, где готовился этот бандл, `8765`
   занят другим процессом, поэтому сервер поднят на `8767` — этот же порт стоит
   в `cordis.patch.yml`, и `tools/check-edt-mcp.mjs` берёт адрес оттуда.
3. **Plain text mode включён** (Preferences → MCP Server → *Plain text mode (Cursor
   compatibility)*). Без него EDT отдаёт результат как embedded resource, а
   `dsh-mcp-client` показывает вместо него заглушку
   `[embedded resource unsupported]` — то есть почти все инструменты становятся
   бесполезными.
4. Проверка живости: `npm run check:edt` — печатает версию сервера,
   число инструментов и делает два безопасных вызова.

## Установка

### Через Web UI (профиль web)

Sidebar → **Plugins** → **Add plugin** → вставить абсолютный путь
`C:\git\dsh-edt-plugin\edt-mcp` → **Install** → **Enable now**.

### Через инструмент `plugin_manager` (режим Creator)

```
plugin_manager { action: "install_bundle", target: "C:\\git\\dsh-edt-plugin\\edt-mcp" }
```

### Из релизного tarball

Начиная с тега `v1.0.0` workflow `release.yml` собирает `edt-mcp` в `.tgz` и прикрепляет
его к GitHub Release. Для **публичного** репозитория бандл ставится прямо по URL:

```
plugin_manager {
  action: "install_bundle",
  target: "https://github.com/pravets/dsh-edt-plugin/releases/download/v1.0.0/local-dsh-edt-mcp-1.0.0.tgz"
}
```

Репозиторий закрытый, поэтому анонимный запрос к этому URL отвечает `404` —
скачайте ассет с токеном и поставьте локальным путём:

```
gh release download v1.0.0 --pattern '*.tgz' -D dist
```

```
plugin_manager {
  action: "install_bundle",
  target: "C:\\git\\dsh-edt-plugin\\dist\\local-dsh-edt-mcp-1.0.0.tgz"
}
```

Менеджер плагинов принимает четыре вида спецификации: имя в реестре npm, абсолютный
путь, git-адрес и tarball (локальный файл или URL).

Установка меняет профиль (`~/.dsh/profiles/web`) и действует на все сессии профиля.
Вручную `package.json` профиля и `cordis.patch.yml` не правим — это делает менеджер.

## Серверы и окружение

Серверы описаны в `cordis.patch.yml` в `config.servers` хаба и включаются окружением:
переустанавливать бандл не нужно, достаточно задать переменные перед запуском DSH.

| Переменная | Что настраивает | По умолчанию |
|---|---|---|
| `EDT_MCP_URL` | MCP-сервер EDT (`mcp__edt__*`) | `http://127.0.0.1:8767/mcp` |
| `EDT_MCP_TOKEN` | заголовок `Authorization: Bearer` для EDT | не задан |
| `DSH_1C_BSL_LS_JAR` | готовый jar BSL Language Server (главнее остальных настроек) | не задан |
| `DSH_1C_BSL_LS_URL` | прямой URL на jar вместо GitHub | не задан |
| `DSH_1C_BSL_LS_VERSION` | тег релиза GitHub, например `v1.0.7` | последний релиз |
| `DSH_1C_BSL_LS_CACHE` | каталог кэша jar | `$DSH_HOME/cache/bsl-language-server` |
| `DSH_1C_BSL_LS_DOWNLOAD` | `0` — не скачивать, работать только с готовым jar | скачивание разрешено |
| `DSH_1C_BSL_LS_JAVA` | java-команда | `java` |
| `DSH_1C_BSL_LS_ROOT` | корень рабочего пространства для BSL LS | рабочий каталог DSH |
| `DSH_1C_BSL_LS_MODE` | `hybrid` (LSP+MCP, по умолчанию) или `stdio` | `hybrid` |
| `DSH_1C_BSL_LS_PORT` | порт встроенного веб-сервера | свободный |
| `DSH_1C_BSL_LS_CWD` | рабочий каталог процесса BSL LS | текущий каталог |
| `DSH_1C_BSL_MCP_URL` | адрес уже запущенного BSL LS по Streamable HTTP (`lsp --mcp`) | не задан |
| `TASKS_MCP_URL` | MCP-сервер системы задач (`mcp__tasks__*`) | не задан |
| `TASKS_MCP_TOKEN` | заголовок `Authorization: Bearer` для трекера | не задан |

Старые имена `BSL_LS_JAR`, `BSL_LS_JAVA`, `BSL_LS_CWD`, `BSL_MCP_URL` пока
принимаются как запасные, но новые `DSH_1C_*` главнее.

У каждого сервера в патче есть три флага:

- `lazy: true` — сервер не подключается на старте и не занимает контекст;
  его инструменты появляются после вызова `mcp_pin("имя")`;
- `provision: true` — параметры запуска добираются на `mcp_pin` (см. ниже);
- `unavailable: !!js '…'` — сервер описан, но настроить его нечем: в правилах
  он назван, а `mcp_pin` вернёт понятную ошибку вместо тишины.

Сейчас EDT подключается сразу (`lazy: false`), а `bsl` и `tasks` — по требованию.

## Автозагрузка BSL Language Server

Если `DSH_1C_BSL_LS_JAR` не задан, хаб скачивает сервер сам при первом
`mcp_pin("bsl")`:

1. если задан `DSH_1C_BSL_LS_URL` — качает по нему;
2. если задан `DSH_1C_BSL_LS_VERSION` — берёт этот тег, иначе последний релиз;
3. из релиза [1c-syntax/bsl-language-server](https://github.com/1c-syntax/bsl-language-server)
   выбирается fat-jar `bsl-language-server-<версия>-exec.jar` (~130 МБ);
4. файл пишется как `<jar>.part` и переименовывается только после сверки
   `sha256` из GitHub API — битая загрузка не останется в кэше;
5. jar кладётся в `DSH_1C_BSL_LS_CACHE` и переиспользуется: следующие pin
   не ходят в сеть.

Скачивание блокирует только вызов `mcp_pin`, а не запуск DSH. При
`DSH_1C_BSL_LS_DOWNLOAD=0` сервер считается ненастроенным, пока нет готового jar.

### Почему гибридный режим

BSL LS получает рабочие пространства **только** через MCP roots, а `dsh-mcp-client`
этот capability не объявляет (`ClientCapabilities[..., roots=null, ...]`). Поэтому
режим `mcp` по stdio отдаёт инструменты, но любой вызов файла заканчивается
`File is not part of any registered workspace`.

Хаб обходит это так: запускает `java -jar … lsp --mcp --server.port=<свободный>`,
сразу отправляет LSP-`initialize` с `workspaceFolders` = `DSH_1C_BSL_LS_ROOT`
(по умолчанию рабочий каталог DSH) и подключает `dsh-mcp-client` уже к
`http://127.0.0.1:<порт>/mcp`. Один процесс обслуживает и LSP, и MCP.

```
DSH_1C_BSL_LS_ROOT=C:\git\tmut\src\cf   # корень конфигурации
```

Если DSH запускается не из каталога конфигурации, корень не нужно прописывать
в окружении: его можно задать при подключении, в том числе другим проектом без
перезапуска приложения:

```
mcp_pin("bsl", root: "C:\\git\\tmut\\src\\cf")
```

Смена корня перезапускает сервер. `mcp_servers` показывает у подключённого сервера
текущий корень и адрес эндпоинта, а путь проекта можно взять из `edt__list_projects`.

Режим `DSH_1C_BSL_LS_MODE=stdio` (или `mcp_pin("bsl", mode: "stdio")`) оставлен для
случая, когда корни не нужны (например, только `type_info`/`global_member_search`).

При `mcp_unpin` и при выгрузке плагина процесс java гасится; при
`DSH_1C_BSL_MCP_URL` хаб ничего не запускает, а подключается к готовому серверу.

Про BSL Language Server: его режим MCP помечен как экспериментальный, а рабочие
пространства он получает через MCP roots — `dsh-mcp-client` roots не отправляет.
Поэтому межфайловые вещи (`find_references` по всему проекту) ограничены; для
корректных границ конфигурации задайте `DSH_1C_BSL_LS_CWD` в корне исходников или
запускайте LS с конфигурационным файлом, где указан `configurationRoot`.

## Подключение по требованию

Хаб регистрирует три мета-инструмента:

| Инструмент | Что делает |
|---|---|
| `mcp_servers` | Перечисляет серверы: `mounted`, `lazy`, `unavailable`, `failed`, транспорт и число инструментов |
| `mcp_pin` | Монтирует сервер и его инструменты; следующий шаг модели уже их видит |
| `mcp_unpin` | Снимает сервер и убирает его инструменты из запроса |

Это не «написать в промпте, что сервер есть»: инструменты, подключённые посреди
сессии, попадают в следующий запрос к модели, а DSH фиксирует изменение блоком
`tool-addition` (у DeepSeek для этого есть beta `mid-conversation-tool-changes`).
Проверено прогоном с поддельным LLM-эндпоинтом: до `mcp_pin` в запросе 32
инструмента без `mcp__tasks__*`, после — 33 с `mcp__tasks__ping`.

Серверы без `lazy` подключаются на старте синхронно, поэтому их инструменты есть
уже в первом запросе; ошибка подключения не валит загрузку — сервер остаётся
в состоянии `failed`, а `mcp-client` продолжает реконнект в фоне.

## Правила для модели

Плагин публикует в системный промпт одну секцию (`order` на единицу больше
`MCP_SERVERS`) с правилами выбора инструментов:

- структуру и метаданные искать через `edt__*`, а не файловым поиском; `grep` и
  чтение файлов — запасной путь;
- **править исходники 1С только инструментами `edt__*`** (`write_module_source`,
  `create_metadata` / `modify_metadata` / `rename_metadata_object` / `delete_metadata`,
  `dcs`, `modify_metadata` с `template`, `apply_quick_fix`), а не через `edit`,
  `write` или `pwsh`: EDT держит модель проекта, и правка мимо него её рассинхронизирует;
- точечную диагностику файла брать у `bsl__analyze_file`, а не у `get_project_errors`
  (это проверка всего проекта и она медленнее);
- типы и глобальные члены платформы сверять через `bsl__type_info` /
  `bsl__global_member_info`, а не по памяти;
- подключать `bsl` или `tasks` через `mcp_pin`, когда задача без них не решается,
  и не пытаться подключить сервер, помеченный как не настроенный;
- менять состояние проекта (`update_database`, `apply_quick_fix`, удаление,
  переименование) только по явной просьбе пользователя;
- ошибку MCP-инструмента называть, а не подменять догадкой.

### Если нужного инструмента в EDT нет

Правила требуют не обходить ограничение молча: модель останавливается, говорит,
какая операция нужна и что уже пробовала в EDT, и предлагает оформить issue —
[github.com/DitriXNew/EDT-MCP/issues](https://github.com/DitriXNew/EDT-MCP/issues)
с версией сервера (`get_edt_version`), именем нужного инструмента и примером задачи.

Прямая правка файла (`edit`/`write`) допустима только по явному разрешению
пользователя на конкретный случай; после неё модель обязана предупредить, что
модель EDT устарела, и предложить `revalidate_objects` или `resync_to_disk`.

Правило включается по факту настроенного EDT-сервера, а не по факту подключения:
если сервер временно недоступен, модель всё равно не начнёт править файлы напрямую.

Имена инструментов в тексте соответствуют EDT-MCP 2.22 и EDT 2026.2 — при
обновлении сервера их стоит сверить.

Текст собирается при каждом запросе и зависит от состояния серверов: пока `bsl`
не смонтирован, про его инструменты в промпте нет ни строки — только про `mcp_pin`.

Текст собирается на старте: если BSL LS или трекер не включены, про них в промпте
ничего нет. Часть правил сервер может отдавать сам — `dsh-mcp-client` публикует
`instructions` из `initialize` отдельной секцией `mcp:<serverName>`.

Командные конвенции стоит держать в `AGENTS.md` проекта: он подхватывается
штатным загрузчиком инструкций DSH и дополняет эти правила.

## Проверка после установки

В списке инструментов появляется `mcp__edt__*`. Быстрая проверка:

- `mcp__edt__get_edt_version`
- `mcp__edt__list_projects`

Если инструментов нет — смотреть логи DSH: строка `edt` в сообщениях `mcp-client`
(подключение/переподключение), и `Server control` в настройках EDT.

## Настройки, которые обычно правят

| Что | Где | Зачем |
|---|---|---|
| `url` | `cordis.patch.yml` | Порт/хост MCP-сервера EDT; переопределяется `EDT_MCP_URL` |
| `toolCallTimeoutMs` | там же, сейчас 900000 | `update_database`, `run_yaxunit_tests`, валидация идут дольше 60 с по умолчанию |
| `failOnStartupError` | там же, `false` | DSH можно запускать при закрытом EDT — плагин дождётся сервера |
| `reconnect.maxAttempts` | там же, 1000 | Ретраи с backoff до 30 с, пока EDT не поднимется |
| `headers.Authorization` | там же (закомментировано) | Если в EDT включён токен: `!!js '`Bearer ${process.env.EDT_MCP_TOKEN}`'` |

На стороне EDT:

- **Tools / Presets** — сервер отдаёт 99 инструментов; для экономии контекста включите
  пресет (`analysis-only`, `development`) или `EDT_MCP_PROGRESSIVE_DISCLOSURE=true`.
- **Destructive consent** — по умолчанию EDT спрашивает подтверждение на удаление,
  rename, `update_database`, `evaluate_expression`. Для автономных прогонов:
  `EDT_MCP_DESTRUCTIVE_CONSENT=allow` в окружении EDT.

## Разработка

```
npm install          # yaml + @modelcontextprotocol/client для проверок
npm run validate     # манифест, YAML-патч, локали, иконка, конфликты serverName
npm test             # текст правил под разные наборы включённых серверов
npm run pack:check   # что попадёт в tarball бандла
npm run check:edt    # живая проверка MCP-сервера EDT
npm run smoke        # полный прогон бандла в одноразовом профиле DSH
```

`validate-bundle.mjs` падает, если из `files` или `exports` манифеста пропал файл,
если в `cordis.patch.yml` нет `serverName`/`url` для http-транспорта, если локали
разошлись по ключам или если у иконки нет `viewBox`. В CI эти же проверки гоняются
на Ubuntu, дополнительно проверяется состав tarball и синтаксис скриптов.

`smoke-bundle.mjs` поднимает одноразовый `DSH_HOME` в `.smoke/`, ставит бандл из
`dist/*.tgz` через `dsh plugin add`, проверяет, что строка плагина и её настройки
попали в композицию профиля, затем поднимает заглушку MCP на порту из патча и
ждёт от неё `initialize` и `tools/list` от настоящего `dsh-mcp-client`. Нужен
установленный DSH: `npm i --no-save @deepseek-ai/dsh@0.2.1-rc.5` (или `DSH_BIN`).
Если порт из патча занят (например, живым сервером EDT), задайте `SMOKE_PORT`.
Smoke гоняется отдельным workflow по расписанию, вручную и на PR, которые
трогают бандл — версия DSH закреплена в `env.DSH_VERSION`.

Релиз: поднять `version` в `edt-mcp/package.json`, добавить запись в `CHANGELOG.md`,
поставить тег `vX.Y.Z` и запушить его — `release.yml` сверит тег с версией и
опубликует tarball.

## Лицензия

MIT — см. [LICENSE](LICENSE).
