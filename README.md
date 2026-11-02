# dsh-edt-plugin

[![CI](https://github.com/pravets/dsh-edt-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/pravets/dsh-edt-plugin/actions/workflows/ci.yml)

Бандл для DeepSeek Harness, который подключает MCP-сервер **1C:EDT** ([DitriXNew/EDT-MCP](https://github.com/DitriXNew/EDT-MCP))
и отдаёт агенту его инструменты как `mcp__edt__<tool>`.

Это «configuration-only» бандл: своего кода нет, только манифест и патч композиции,
который вставляет уже установленный плагин `@deepseek-ai/dsh-mcp-client`.

**Статус:** работает. Сервер `edt-mcp-server` 2.22.1 на `127.0.0.1:8767`, EDT 2026.1.2.2,
бандл установлен в профиль `web`, инструменты доступны как `mcp__edt__*` (99 штук).

## Состав

```
edt-mcp/
  package.json           манифест бандла (dsh.bundle.patch)
  cordis.patch.yml       строка @deepseek-ai/dsh-mcp-client + параметры подключения
  locale/en.json         название и описание для карточки плагина
  locale/ru.json
  icon.svg
tools/
  check-edt-mcp.mjs      проверка сервера без установки бандла
  validate-bundle.mjs    проверка манифеста, патча, локалей и иконки (CI)
.github/workflows/
  ci.yml                 валидация на push и pull request
  release.yml            tarball бандла в GitHub Release по тегу v*
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

## Проверка после установки

В списке инструментов появляется `mcp__edt__*`. Быстрая проверка:

- `mcp__edt__get_edt_version`
- `mcp__edt__list_projects`

Если инструментов нет — смотреть логи DSH: строка `edt` в сообщениях `mcp-client`
(подключение/переподключение), и `Server control` в настройках EDT.

## Настройки, которые обычно правят

| Что | Где | Зачем |
|---|---|---|
| `url` | `cordis.patch.yml` | Порт/хост MCP-сервера EDT |
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
npm run validate     # манифест, YAML-патч, паритет локалей en/ru, иконка
npm run pack:check   # что попадёт в tarball бандла
npm run check:edt    # живая проверка MCP-сервера EDT
```

`validate-bundle.mjs` падает, если из `files` или `exports` манифеста пропал файл,
если в `cordis.patch.yml` нет `serverName`/`url` для http-транспорта, если локали
разошлись по ключам или если у иконки нет `viewBox`. В CI эти же проверки гоняются
на Ubuntu, дополнительно проверяется состав tarball и синтаксис скриптов.

Релиз: поднять `version` в `edt-mcp/package.json`, добавить запись в `CHANGELOG.md`,
поставить тег `vX.Y.Z` и запушить его — `release.yml` сверит тег с версией и
опубликует tarball.

## Лицензия

MIT — см. [LICENSE](LICENSE).
