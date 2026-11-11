# dsh-edt-projects

[![CI](https://github.com/pravets/dsh-edt-projects/actions/workflows/ci.yml/badge.svg)](https://github.com/pravets/dsh-edt-projects/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/pravets/dsh-edt-projects)](https://github.com/pravets/dsh-edt-projects/blob/master/LICENSE)
[![Telegram](https://telegram-badge.vercel.app/api/telegram-badge?channelId=@pravets_IT)](https://t.me/+GKGRmAwghxllYzIy)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Плагин [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) для
разработки на 1С. Держит подключённым **1C:EDT** через
[EDT-MCP](https://github.com/DitriXNew/EDT-MCP), поднимает по требованию
**BSL Language Server**, при необходимости подключает MCP-сервер трекера и
добавляет в системный промпт правила, по которым агент работает с конфигурацией
1С, а не с файлами наугад.

Плагин включается **только в выбранных проектах** (см. «Где включается»). В
остальных сессиях в контексте остаётся один маленький инструмент `edt_config`:
ни правил 1С, ни MCP-инструментов, ни навыков там нет.

## Что вы получаете

- **`mcp__edt__*` — инструменты EDT во включённых проектах.** Метаданные и
  объекты, формы, СКД, запросы, сборка внешних обработок, YAxUnit — около ста
  инструментов сервера `edt-mcp-server`. Монтируются при создании сессии, а не в
  чужие проекты.
- **`mcp__bsl__*` — BSL Language Server по требованию.** Диагностика конкретного
  файла, переходы, иерархия вызовов, типы платформы. Монтируется через `edt_pin`,
  чтобы его схемы не занимали контекст постоянно.
- **`mcp__tasks__*` — любой MCP-сервер трекера** (YouTrack, Jira, GitLab, GitHub)
  тем же способом.
- **`mcp__v8std__*` — стандарты 1С и диагностики.** Публичная read-only база
  [v8std.ru](https://v8std.ru): объясняет код ошибки EDT/BSL и правило, на которое
  он ссылается. Подключается по требованию (`edt_pin("v8std")`); свой инстанс —
  через `servers.v8std.url` или `V8STD_MCP_URL`.
- **Настройки на проект.** Второй проект — другой `.dsh-1c.json`, без перезапуска
  DSH: порт EDT, корень исходников для BSL, вики, флаги тестов и навыков.
- **Свой EDT- workspace в git worktree.** В linked worktree плагин сам поднимает
  EDT в `<worktree>/build/ws` на отдельном порту, импортирует проекты и монтирует
  `mcp__edt__*` туда — параллельные worktree не мешают друг другу и основному
  checkout. Останавливается, когда закрылась последняя сессия.
- **Вики проекта только для чтения.** Пути попадают в промпт, запись по ним
  отклоняется на уровне инструментов.
- **Правила для модели.** «Исходники 1С правим только инструментами EDT», точечная
  диагностика через BSL, изменения состояния проекта — только по явной просьбе.
- **Навыки SonarQube и GitLab** и правила тестируемости (YAxUnit, Vanessa) —
  навыки включаются сами по маркерам репозитория, флаг в конфиге сильнее.

## Требования

1. **DSH 0.2.x** и профиль (`desktop` или `web`).
2. **EDT 2026.1 / 2026.2 с установленным EDT-MCP**: Help → Install New Software →
   `https://ditrixnew.github.io/EDT-MCP/` → EDT MCP Server Feature → перезапуск.
   Для основного checkout EDT запускается вручную (п. 3); в worktree плагин находит
   установку сам (`workspace.home` или `DSH_1C_EDT_HOME`, иначе старшая найденная).
3. **MCP-сервер запущен в основном checkout**: Window → Preferences → MCP Server →
   Server Port и автостарт. Порт по умолчанию — `8765`, плагин по умолчанию ходит
   туда же. В worktree сервер поднимается сам вместе с отдельным workspace.
4. **Plain text mode включён** (там же, *Plain text mode (Cursor compatibility)*).
   Без него EDT отдаёт результат как embedded resource, а клиент показывает вместо
   него `[embedded resource unsupported]` — и инструменты становятся бесполезны.

## Установка

```text
plugin_manager { action: "install_bundle", target: "dsh-edt-projects" }
```

Пакет публичный, поэтому этого достаточно: менеджер плагинов возьмёт его из npm и
включит. После установки перезапуск DSH не нужен; инструменты 1С появятся в новой
сессии, каталог которой выбран (см. «Где включается»).

Другие способы — для разработки и закрытых сетей:

| Способ | Что передать |
|---|---|
| локальные исходники | `install_bundle` с путём `C:\git\dsh-edt-plugin\packages\dsh-edt-projects` (создаёт `link:`, правки видны после пересборки профиля) |
| релизный tarball | URL `https://github.com/pravets/dsh-edt-projects/releases/download/v0.13.0/dsh-edt-projects-0.13.0.tgz` |
| Web UI | Plugins → Add plugin → тот же путь или URL |

## Где включается

Плагин не активен глобально: при создании сессии он смотрит на **исходный каталог
сессии** и решает так:

| Условие | Итог |
|---|---|
| `enabled: true` в настройках проекта или пользователя | включён |
| `enabled: false` там же | выключен, даже если есть файл проекта и путь в списке |
| в каталоге сессии есть разбираемый `.dsh-1c.json` | включён |
| каталог (или его предок) есть в `projects` файла `$DSH_HOME/dsh-1c.json` | включён |
| ничего из перечисленного | выключен |

Сравнение путей идёт по границе каталога (`C:\git\trade2` не считается проектом
`C:\git\trade`), `~` раскрывается, на Windows регистр не важен. Битый JSON не
включает проект: ошибка пишется в лог, а `edt_config` остаётся доступным.

**Worktree наследует включённость.** Если каталог сессии — linked git worktree,
плагин находит его основной checkout (или репозитории первого уровня, как в task
space у `dsh-worktree-space`) и проверяет `enabled`, `projects` и `.dsh-1c.json` по
ним. Отдельный `.dsh-1c.json` в worktree не нужен, а если он есть (например,
закоммичен) — он сильнее настроек основного checkout. Подробности и настройка
окружения — в разделе «EDT-окружение в git worktree».

В выключенном проекте от плагина остаётся только `edt_config` — у него же
`action=init` создаёт `.dsh-1c.json` и тем самым включает проект на лету. В
включённом — правила 1С, `mcp__edt__*`, `edt_servers`/`edt_pin`/`edt_unpin`/
`edt_reload`, вики, навыки и правила тестируемости.

## Быстрый старт

1. Установить плагин (команда выше) и начать новую сессию в каталоге проекта.
2. Включить проект: в нём вызвать `edt_config action=init` (создаст
   `.dsh-1c.json`) или добавить путь в `projects` пользовательского файла.
3. Проверить связку: вызвать `mcp__edt__get_edt_version` и
   `mcp__edt__list_projects`. Если инструментов нет — раздел «Диагностика».
4. Если порт EDT не 8765, или нужна вики, или флаги тестов — дополнить
   `.dsh-1c.json` (см. ниже).

## Настройки

Два файла, одинаковый формат, читаются на каждый `edt_pin`, `edt_reload`, каждый
шаг и каждый рендер промпта:

| Слой | Файл |
|---|---|
| пользователь | `$DSH_HOME/dsh-1c.json` |
| проект | `<каталог, где создана сессия>/.dsh-1c.json` |

Приоритет: проект > пользователь > встроенные значения `cordis.patch.yml`.
Проект определяется **исходным** каталогом сессии: `cd` внутри сессии не
переключает конфиг, корень BSL и пути вики.

```json
{
  "enabled": true,
  "projects": ["C:\\git\\trade"],
  "wiki": { "paths": ["C:\\git\\dev-llm-wiki"], "entry": "wiki/index.md" },
  "servers": {
    "edt":   { "url": "http://127.0.0.1:8765/mcp" },
    "bsl":   { "root": "C:\\git\\trade\\src\\cf" },
    "tasks": { "url": "https://tracker.example/mcp" }
  },
  "workspace": { "import": "auto", "xmxIde": "6g" },
  "tests":  { "yaxunit": { "enabled": true, "project": "cfe_yaxunit" } },
  "sonar":  { "enabled": true },
  "gitlab": { "enabled": false }
}
```

| Ключ | Смысл | По умолчанию |
|---|---|---|
| `enabled` | явно включить/выключить плагин для проекта | не задан: решают файл проекта и `projects` |
| `projects` | каталоги, где плагин включён (обычно в пользовательском файле) | пусто |
| `servers.edt.url` | адрес MCP-сервера EDT | `http://127.0.0.1:8765/mcp` |
| `servers.edt.toolCallTimeoutMs` | таймаут вызова: `update_database`, `run_yaxunit_tests` идут дольше 60 с | `900000` |
| `servers.bsl.jar` / `url` / `version` | готовый jar, зеркало или закреплённый тег релиза | не заданы |
| `servers.bsl.root` | корень исходников для BSL LS | каталог запуска DSH |
| `servers.bsl.mode` | `hybrid` (LSP+MCP) или `stdio` | `hybrid` |
| `servers.tasks.url` | MCP-сервер трекера | не задан |
| `servers.v8std.url` / `headers` | адрес MCP-сервера стандартов (свой инстанс) | `https://ai.v8std.ru/mcp` из `cordis.patch.yml` |
| `wiki.paths` / `wiki.entry` | корни вики и входная страница | пусто |
| `workspace.enabled` | поднимать ли отдельный EDT-workspace в worktree | `true` |
| `workspace.home.win32` / `linux` | каталог установки EDT (где `1cedt.exe`); пусто — автопоиск | пусто |
| `workspace.import` | импорт проектов в новый workspace: `true`, `false`, `"auto"` | `"auto"` |
| `workspace.projects` | шаблоны EDT-проектов для импорта; пусто — все каталоги с `.project` до 3 уровней | пусто |
| `workspace.ports.min` / `max` | диапазон портов MCP-сервера worktree | `20000–39999` |
| `workspace.xmxIde` / `xmxImport` | память EDT и `1cedtcli` | `6g` / `8g` |
| `workspace.stopOnSessionEnd` | останавливать EDT после последней сессии на worktree | `true` |
| `workspace.plainText` | Plain text mode вместо embedded resource (DSH их не рендерит) | `true` |
| `workspace.formScreenshots` | включить `get_form_screenshot` и JVM-флаг `nativeFormBufferedLayoutRender` | `true` |
| `tests.yaxunit` / `tests.vanessa` | правила тестируемости | выключены |
| `sonar.enabled` | навык SonarQube: не задан — авто по `sonar-project.properties`, `sonar.projectKey` или серверу `sonarqube`; `true`/`false` — принудительно | авто |
| `sonar.projectKey` | ключ проекта для навыка Sonar | из `sonar-project.properties` |
| `gitlab.enabled` | навык GitLab: не задан — авто по `.gitlab-ci.yml` и `.gitlab/merge_request_templates`; `true`/`false` — принудительно | авто |

`servers.*.shared` больше не работает: сервер всегда монтируется в скоупе
сессии. Полный список ключей, включая `servers.bsl.java`, `cwd`, `port` и
`servers.*.headers`, — в схеме `edt_config action=validate` и в
`packages/dsh-edt-projects/cordis.patch.yml`.

**Создать файл и дополнить новыми ключами:**

```text
node tools/config-init.mjs            # .dsh-1c.json проекта
node tools/config-init.mjs --user     # $DSH_HOME/dsh-1c.json
node tools/config-init.mjs --dry-run  # показать, что добавится
```

Из сессии то же делает инструмент `edt_config`: `show` (действующие значения,
источники и включён ли проект), `init`, `upgrade` (дописывает только
отсутствующие ключи, по умолчанию `dryRun: true`), `validate`. Существующие
значения не меняются никогда, битый JSON не перезаписывается; `enabled` в
дефолты не входит, чтобы `upgrade` не выключил уже включённый проект.

**Что применяется на лету:**

| Изменение | Как применить |
|---|---|
| `wiki.paths`, `servers.bsl.root` | сразу: читаются на каждый запрос и `edt_pin` |
| `servers.<name>.url`, `headers` | `edt_reload("edt")` — сервер переподключится |
| `enabled`, `projects` | сразу: на следующем шаге сессии |
| `workspace.*` | `edt_workspace action=restart` — подъём идёт по снимку настроек |
| `cordis.patch.yml`, переменные окружения | только перезапуск DSH |

Переменные окружения — для разовых запусков и CI:

| Переменная | Что задаёт |
|---|---|
| `EDT_MCP_URL`, `EDT_MCP_TOKEN` | адрес и токен MCP-сервера EDT |
| `TASKS_MCP_URL`, `TASKS_MCP_TOKEN` | адрес и токен трекера |
| `V8STD_MCP_URL`, `V8STD_MCP_TOKEN` | адрес и токен MCP-сервера стандартов (по умолчанию `https://ai.v8std.ru/mcp`) |
| `DSH_1C_WIKI`, `DSH_1C_WIKI_ENTRY` | корни вики через `;` и входная страница |
| `DSH_1C_BSL_LS_JAR`, `DSH_1C_BSL_LS_URL` | готовый jar или зеркало |
| `DSH_1C_BSL_LS_VERSION` | закреплённый тег, например `v1.0.7` |
| `DSH_1C_BSL_LS_GITHUB_TOKEN` | токен GitHub для API (иначе `GITHUB_TOKEN`, `GH_TOKEN`) |
| `DSH_1C_BSL_LS_CACHE`, `DSH_1C_BSL_LS_DOWNLOAD` | каталог кэша и запрет скачивания |
| `DSH_1C_BSL_LS_ROOT`, `DSH_1C_BSL_LS_CWD` | корень рабочего пространства и рабочий каталог LS |
| `DSH_1C_EDT_HOME` | каталог установки EDT для worktree (перекрывает `workspace.home`) |
| `DSH_1C_EDT_IMPORT` | `1`/`0` — импортировать ли проекты в workspace worktree |

## EDT-окружение в git worktree

Основной checkout работает с одним EDT, запущенным вручную, — и это правильно:
он один. Параллельные worktree так работать не могут: у каждого свой набор
исходников, а один EDT- workspace показывает один набор проектов. Поэтому в linked
worktree плагин поднимает **отдельное окружение** и монтирует `mcp__edt__*` на его
порт.

```text
<worktree>/build/
├── ws/                              EDT workspace (-data) с prefs MCP-сервера
├── logs/init.log | edt.log | edt-import.log
├── workspace.json                   снимок настроек, по которому поднимали
├── edt-mcp-port | edt-mcp.pid
├── edt-mcp-ready | edt-mcp-failed   маркеры готовности
├── edt-imported | import.script
└── init-progress.json               фаза подъёма для статуса
```

Что происходит при создании сессии в worktree:

1. Плагин видит linked worktree и наследует включённость от основного checkout.
2. Занимает свободный порт из `workspace.ports`, пишет prefs MCP-сервера
   (`mcpServerAutoStart=true`, порт) и снимок настроек в `build/workspace.json`.
3. Запускает в фоне `init`: при необходимости импортирует EDT-проекты
   (`1cedtcli`), стартует `1cedt` с `-data build/ws` и ждёт `/health`.
   Первый запуск — 1–3 минуты, с импортом дольше.
4. Монтирует `edt` на `http://127.0.0.1:<порт>/mcp` с реконнектом: инструменты
   появляются, как только сервер поднялся, а неудачное стартовое подключение не
   валит сессию.
5. Когда закрылась последняя сессия на этом worktree, останавливает EDT, если его
   поднял сам (`workspace.stopOnSessionEnd`, по умолчанию `true`). Окружение,
   поднятое opencode, плагин принимает и не останавливает.

Состояние, порт, фазу и логи показывает `edt_workspace`:

| Действие | Что делает |
|---|---|
| `status` | корень, `build/ws`, состояние (`absent`/`stopped`/`starting`/`ready`/`stale`/`failed`), порт, pid, фаза, число импортированных проектов, предупреждения |
| `init` | поднять (или повторить неудачный запуск); возвращается сразу, работа идёт в фоне |
| `stop` | остановить EDT этого worktree |
| `restart` | остановить и поднять заново; `import: true` — заново импортировать проекты |
| `import` | импорт при остановленном EDT (если запущен — подскажет `restart`) |

Настройки — в обычных файлах плагина, секция `workspace`:

```json
{
  "workspace": {
    "home": { "win32": "C:\\Program Files\\1C\\1CE\\components\\1c-edt-2026.1.2+2-x86_64" },
    "root": "",
    "import": "auto",
    "projects": ["src/cf", "src/cfe/*", "src/epf/*"],
    "xmxIde": "6g",
    "ports": { "min": 20000, "max": 39999 },
    "stopOnSessionEnd": true
  }
}
```

- `workspace.home` пустой — плагин берёт старшую найденную установку EDT
  (`C:\Program Files\1C\1CE\components\1c-edt-*`, `/opt/1C/1CE/components`),
  предпочитая ту, где в `plugins`/`features` есть EDT-MCP. Java ищется рядом
  (`jdk-full-17`), `workspace.vm` перекрывает.
- `workspace.import: "auto"` импортирует, только если в workspace ещё нет
  проектов. `true` — импортировать по списку `workspace.projects` (пусто — все
  каталоги с `.project` до трёх уровней), `false` — не импортировать (проекты
  можно добавить в EDT вручную).
- `workspace.root` пустой — окружение в корне worktree. Если в task space
  несколько включённых репозиториев, берётся первый по сортировке и в `status`
  появляется предупреждение; `workspace.root` (абсолютный или относительный от
  корня worktree) выбирает нужный.
- `build/` должен быть в `.gitignore` репозитория (у типовых 1С-проектов уже там).
  Если это не так, `status` предупредит; чужие `.gitignore` плагин не правит.

Уборка без DSH:

```text
node tools/edt-workspace.mjs status --root <worktree>
node tools/edt-workspace.mjs stop   --root <worktree>
node tools/edt-workspace.mjs stop-all --repo C:\git\trade
```

Окружение поднимается только в **linked worktree**. Обычный каталог, основной
checkout и выключенный проект ничего не запускают — там работает EDT из
`servers.edt.url`. Механизм не зависит от конкретного плагина worktree: подходит
`git worktree add`, task space из `dsh-worktree-space`, worktree opencode и
экспериментальный `create_worktree` DSH — плагин определяет worktree по `.git`-
файлу и `commondir`, без вызова git и без чужих событий.

## Совместно с dsh-git-worktree

Плагин рассчитан на работу с [dsh-git-worktree](https://github.com/LaoYueHanNi/dsh-git-worktree): он создаёт
изолированный worktree в `<repo>/.dsh/gitworktree/<branch>/`, регистрирует его как обычный DSH
Workspace и открывает там сессию.

- Специальной настройки не нужно: worktree определяется по `.git`-файлу и `commondir`, поэтому
  in-repo layout и legacy `~/.dsh/gitworktree` поддерживаются одинаково.
- Если сессия открыта в основном checkout, но `workingDirectory` указывает в worktree этого же
  репозитория, плагин считает проектом worktree и поднимает окружение там.
- `build/` окружения лежит внутри worktree, который и так исключён из git; освобождать каталог
  вручную не требуется.
- Перед удалением worktree закройте сессию (`stopOnSessionEnd` остановит EDT) или вызовите
  `edt_workspace action=stop`.

### Скриншоты форм и plain text

DSH не рендерит embedded resource, поэтому в workspace сразу включаются:

- `mcpPlainTextMode=true` — EDT-MCP отдаёт markdown/текст вместо resource (`list_projects`,
  `get_project_errors` и т.д.). Настройка `workspace.plainText: false` возвращает прежнее
  поведение сервера. Ключ пишется в
  `build/ws/.metadata/.plugins/org.eclipse.core.runtime/.settings/com.ditrix.edt.mcp.server.prefs`
  до запуска EDT (там же `mcpServerHttpEnabled=true`); сервер читает его через
  `Activator.getPreferenceStore()` при каждом вызове инструмента, но store кэшируется на
  время работы — если EDT уже запущен, нужен `edt_workspace action=restart`. Отдельной
  переменной окружения для plain text в EDT-MCP нет.
- `mcpDisabledTools` без `get_form_screenshot` и JVM-флаг
  `-DnativeFormBufferedLayoutRender=true` после `-vmargs` — иначе `get_form_screenshot` на Windows
  не работает. Настройка `workspace.formScreenshots: false` выключает и флаг, и инструмент.
  На Windows этот флаг включает буферизованный рендер форм на всю сессию EDT: собственный
  дизайнер форм показывает серый прямоугольник — это поведение EDT, а не плагина. Смена
  флага требует перезапуска окружения (`edt_workspace action=restart`).

## Серверы по требованию

Собственные инструменты плагина названы с префиксом `edt_`, чтобы не пересекаться
с чужими MCP-плагинами и с серверными `mcp__edt__*`:

| Инструмент | Что делает |
|---|---|
| `edt_config` | настройки плагина: включение проекта, вики, тесты, серверы, навыки; `show`/`init`/`upgrade`/`validate` |
| `edt_servers` | состояние серверов: `mounted`, `lazy`, `unavailable`, `failed`, транспорт, число инструментов |
| `edt_pin` | монтирует сервер; его инструменты появляются в следующем же запросе модели |
| `edt_unpin` | снимает сервер и освобождает контекст |
| `edt_reload` | перечитывает настройки и перезапускает серверы с изменившимся конфигом |
| `edt_workspace` | окружение EDT в worktree: `status`/`init`/`stop`/`restart`/`import` |

`edt_config` доступен всегда — им включают проект. Остальные пять видны только
во включённом проекте.

EDT монтируется при создании сессии включённого проекта (`lazy: false`), BSL LS,
трекер и v8std — по требованию. Каждая сессия (и субагент) получает свой MCP-клиент:
для EDT это отдельное HTTP-подключение, отдельный workspace в EDT не создаётся.
Ошибка подключения не валит старт: сервер остаётся в состоянии `failed`, клиент
продолжает реконнект в фоне. Для `bsl` корень можно передать прямо при
монтировании: `edt_pin("bsl", root: "C:\\git\\trade\\src\\cf")`.

## BSL Language Server

Если `servers.bsl.jar` не задан, плагин скачивает сервер сам при первом
`edt_pin("bsl")`: из кэша → со страниц релизов GitHub → через API (если задан
токен) → по предсказуемому адресу → из любого другого jar в кэше. Файл пишется как
`.part` и переименовывается только после сверки `sha256`; несовпадение хеша
обрывает загрузку, а не повторяется без проверки.

- Без токена загрузка идёт со страниц релизов и **не упирается в лимит GitHub API**
  (60 запросов в час на IP). С `DSH_1C_BSL_LS_GITHUB_TOKEN` — 5000/ч, API первым.
- Если лимит всё же исчерпан, ошибка называет время сброса и выходы: задать токен,
  закрепить `DSH_1C_BSL_LS_VERSION`, указать `URL` или готовый `JAR`.
- Кэш (`$DSH_HOME/cache/bsl-language-server`) переиспользуется: следующие `pin`
  не ходят в сеть.

**Гибридный режим.** BSL LS узнаёт о рабочих пространствах только через MCP roots,
а `dsh-mcp-client` этот capability не объявляет. Поэтому плагин запускает
`java -jar … lsp --mcp --server.port=<порт>` и сам отправляет LSP-`initialize` с
`workspaceFolders`, а клиент подключает к `http://127.0.0.1:<порт>/mcp`. Один процесс
обслуживает и LSP, и MCP. Границы конфигурации задаёт `DSH_1C_BSL_LS_ROOT`; если
корень не тот, межфайловые операции работают хуже, чем могли бы.

## Стандарты и ошибки (v8std)

[v8std.ru](https://v8std.ru) — публичная база стандартов 1С и диагностик с
MCP-эндпоинтом `https://ai.v8std.ru/mcp` (страница `v8std.ru/mcp/` — это описание,
а не адрес сервера). Плагин подключает её как сервер `v8std`: он только читает и
объясняет, но не анализирует проект и не меняет код.

| Инструмент | Что делает |
|---|---|
| `v8std_explain_diagnostics` | по коду из отчёта EDT/BSL (`acc 1245`, `АПК:361`, `bslls:AssignAliasFieldsInQuery`, v8cs) находит диагностику, связанные стандарты и частоту |
| `v8std_search` | поиск по базе: тема, вопрос или неточный идентификатор |
| `v8std_get_page` | полный Markdown статьи по id, псевдониму или URL (`std437`) |
| `v8std_get_related` | связи стандарта и диагностик |
| `v8std_explain_snippet` | эвристический разбор одного метода BSL или фрагмента SDBL |

Порядок, которому следуют правила плагина: EDT (`get_project_errors`) или BSL LS
(`analyze_file`) выдал код → `edt_pin("v8std")` → `v8std_explain_diagnostics` →
`v8std_get_page` → правка через EDT-MCP. Результат поиска — справка, а не
подтверждение нарушения: проверку даёт анализатор, v8std объясняет правило.

Сервер ленивый, чтобы пять его схем не занимали контекст постоянно. Значение по
умолчанию (`https://ai.v8std.ru/mcp`) живёт в `cordis.patch.yml`, поэтому файл
настроек его не перекрывает, пока вы сами этого не захотите. Переопределение — в
любом из файлов настроек, приоритет как обычно проект > пользователь > патч:

```json
{ "servers": { "v8std": { "url": "http://v8std.example:8080/mcp" } } }
```

Переменные: `V8STD_MCP_URL` (адрес) и `V8STD_MCP_TOKEN` (Bearer, если инстанс
требует авторизацию). Чтобы держать сервер подключённым всегда, добавить
`"servers": {"v8std": {"lazy": false}}`. Без сети сервер останется в `failed` —
остальные инструменты работают, а правила требуют сказать об этом, а не придумывать
стандарт.

## Вики проекта

При заданном `wiki` в промпт добавляется блок с путями и входной точкой, а запись
по этим путям запрещена на уровне инструментов: `edit`, `write`,
`str_replace_editor` и `apply_patch` отклоняются с сообщением «Вики доступна только
для чтения». Чтение (`read`, `grep`, `glob`) работает как обычно — это документация,
а не конфигурация, правило «правки только через EDT» к ней не относится.

Входная точка ищется по порядку: `entry` из настроек → `wiki/index.md` →
`index.md` → `README.md` → `AGENTS.md`. Несуществующие каталоги отбрасываются с
предупреждением в лог.

## Тесты и навыки

Флаги включают в промпт правила тестируемости:

```json
{ "tests": { "yaxunit": { "enabled": true, "project": "cfe_yaxunit" }, "vanessa": { "enabled": true } } }
```

- `yaxunit` — закладывать тестируемость: логика отдельными процедурами без побочных
  эффектов, зависимости параметрами, тонкие обработчики, изоляция через Мокито;
  тесты писать в указанный проект.
- `vanessa` — если юнитов мало (интеграция, обмен, интерфейс, печатные формы),
  предлагать 2–3 сценария с шагами и ожидаемым результатом, не создавая их молча.

Навыки появляются в каталоге только во включённом проекте; они приходят из пакета,
так что проектный навык с тем же именем их переопределяет. Включение трёхзначное:
ключ не задан — навык включается по маркеру репозитория, `true`/`false` — сильнее
маркера:

```json
{ "sonar": { "enabled": true }, "gitlab": { "enabled": false } }
```

При `edt_config upgrade` файл версии 3 и старше теряет прежний `enabled: false`
(это было значение по умолчанию, а не выбор) и навык переходит в авто-режим;
явный `false` в файле версии 4 остаётся запретом.

- `edt-mcp-project-gitlab` — включается сам, если в репозитории есть
  `.gitlab-ci.yml` или `.gitlab/merge_request_templates/`. Отвечает на вопросы:
  как оформить MR (сначала `AGENTS.md` и шаблон репозитория, иначе Summary /
  Evidence / Merge Danger), как создать его без интерактивных вопросов, какие
  замечания ревью висят неразрешёнными, как ответить в тред, как резолвнуть его
  после правки, как прочитать пайплайн и почему упал job. Мерж — только по
  отдельной явной просьбе пользователя; зелёный пайплайн и одобрение ревьюеров
  разрешением не считаются.
- `edt-mcp-project-sonar` — включается сам, если есть `sonar-project.properties`,
  задан `sonar.projectKey` или настроен сервер `sonarqube`. Отвечает за замечания
  Sonar (`--statuses OPEN,CONFIRMED`, компактный `--format toon` для чтения и
  `json` для разбора), качественный гейт, поиск ключа проекта через
  `sonar list projects` и цикл правки через EDT-MCP. Замечания Sonar и треды
  ревью — разные источники, навык не смешивает их.

Адреса и ключи в текстах навыков не зашиты: сервер Sonar, ключ проекта, GitLab-хост
и `glab`-авторизация определяются в момент работы. Мерж без явного запроса,
force-push, пуш в основную ветку и резолв неразобранных тредов запрещены текстом
навыка. `edt_config action=show` печатает строку «Навыки» с причиной включения
(флаг, маркер или «нет флага и маркера»).

## Правила для модели

Во включённом проекте плагин добавляет в системный промпт одну секцию: искать
структуру и метаданные через `edt__*`, а не файловым поиском; **править исходники
1С только инструментами EDT** (`write_module_source`, `create_metadata`,
`modify_metadata`, `dcs`, `apply_quick_fix`), иначе модель EDT разъезжается с
диском; точечную диагностику брать у `bsl__analyze_file`, а не у
`get_project_errors`; типы платформы сверять по `bsl__type_info`; менять состояние
проекта (`update_database`, удаление, переименование) только по явной просьбе.

Если нужного инструмента в EDT нет, модель должна остановиться и назвать операцию,
а не обходить ограничение файловыми правками. Секция собирается под фактически
настроенные серверы: пока `bsl` не смонтирован, про его инструменты в промпте нет ни
строки. В выключенном проекте секция пустая и в промпт не попадает.

## Диагностика

| Симптом | Что делать |
|---|---|
| нет `mcp__edt__*` | `edt_config action=show` → включён ли проект; затем `edt_servers` → состояние `edt`, порт и запущенный сервер в EDT |
| `edt_pin("bsl")` падает «не удалось получить релиз» | задать `DSH_1C_BSL_LS_JAR`, `URL` или `VERSION`; при лимите — `DSH_1C_BSL_LS_GITHUB_TOKEN` |
| `[embedded resource unsupported]` | включить Plain text mode в настройках MCP-сервера EDT |
| BSL не видит файлы конфигурации | задать `DSH_1C_BSL_LS_ROOT` (корень исходников) |
| `edt_pin("v8std")` не подключается | проверить `V8STD_MCP_URL` / `servers.v8std.url`, доступ к сети или свой инстанс; без него стандарты можно смотреть на [v8std.ru](https://v8std.ru) |
| правки не видны в EDT | править через `edt__*`; после ручной правки — `revalidate_objects` или `resync_to_disk` |
| плагин не появился в списке | `plugin_manager list_bundles`; проверить, что версия DSH ≥ 0.2.0 |
| в worktree нет `mcp__edt__*` | `edt_workspace action=status`: `starting` — подождать (импорт 19 проектов ≈ 11 мин), `failed` — смотреть `build/logs/edt.log`, `off` — проверить, что это linked worktree и проект включён |
| `edt_workspace status`: «EDT-MCP не подтверждён по файлам» | это только эвристика: бандл может стоять в пользовательской `~/.eclipse/...`; готовность подтверждает `/health` после `ready` |
| `edt_workspace status`: EDT не найден | задать `workspace.home.win32` или `DSH_1C_EDT_HOME` |
| EDT падает сразу после старта, `failed` за секунды | проверить `status` → «Java … (EDT требует N)»; задать `workspace.vm` на `jdk-full-<N>` или убрать `-vm` |
| импорт в worktree завис/упал | прогресс и хвост — в `build/ws/.metadata/.log` (он же digest в `build/logs/edt-import.log`); повторить `edt_workspace action=init`, при необходимости `restart` с `import: true` |
| `get_form_screenshot` нет в `tools/list` | `workspace.formScreenshots` должен быть `true`; после `restart` проверить prefs `mcpDisabledTools` и флаг `-DnativeFormBufferedLayoutRender=true` |
| навыка GitLab или Sonar нет в каталоге | `edt_config action=show` → строка «Навыки» и причина; включить `"gitlab": { "enabled": true }` / `"sonar": { "enabled": true }` или добавить маркер репозитория (`.gitlab-ci.yml`, `sonar-project.properties`) |
| после переименования каталога плагина ошибки про старый путь | переустановить плагин: `remove_bundle`, затем `install_bundle` |

Живая проверка без DSH: `npm run check:edt` — печатает версию сервера, число
инструментов и делает два безопасных вызова.

## Разработка

```text
packages/dsh-edt-projects/   бандл: манифест, cordis.patch.yml, lib/, skills/, locale/, иконка
tools/                       проверки, тесты, smoke, заглушка MCP
.github/workflows/           CI, Release по тегу, Smoke по расписанию
```

```text
npm ci               # зависимости проверок
npm run validate     # манифест, патч, локали, иконка, готовность к публикации, порт
npm test             # 214 проверок: правила, BSL, конфиг, включение, worktree, окружение, вики, схема, навыки, cwd
npm run pack:check   # состав tarball
npm run check:edt    # живой MCP-сервер EDT
npm run smoke        # прогон бандла в одноразовом профиле DSH
npm run workspace -- status --root <worktree>   # окружение worktree без DSH
npm run workspace:stop-all -- --repo C:\git\trade
```

Smoke ставит бандл из `dist/*.tgz` в одноразовый `DSH_HOME`, проверяет композицию
профиля и поднимает заглушку MCP на порту из патча. Затем дважды стартует headless
сессию: из каталога без `.dsh-1c.json` (заглушка не должна получить `initialize`) и
из каталога с `.dsh-1c.json` (должна). Нужен установленный DSH
(`npm i --no-save @deepseek-ai/dsh@0.2.1-rc.5` или `DSH_BIN`); если порт занят живым
EDT — задайте `SMOKE_PORT`.

**Релиз:** поднять `version` в `packages/dsh-edt-projects/package.json`, добавить
запись в `CHANGELOG.md`, поставить тег `vX.Y.Z` и запушить. `release.yml` сверит тег
с версией, соберёт tarball, приложит его к GitHub Release и опубликует версию в npm
через trusted publisher (OIDC, без токенов и секретов).

## Версионирование

Проект в статусе беты и версионируется как **0.x** (текущая — `v0.13.0`). Между 0.x
без миграции могут меняться ключи конфига, имена инструментов и структура
`cordis.patch.yml`; `edt_config upgrade` дополняет файл, но совместимость не
гарантирует. Версия 1.0.0 будет означать зафиксированный API. История — в
[CHANGELOG.md](CHANGELOG.md).

## Лицензия

MIT — см. [LICENSE](LICENSE).

