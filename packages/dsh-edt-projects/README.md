# dsh-edt-projects

Плагин [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) для
разработки на 1С: держит **1C:EDT** подключённым через
[EDT-MCP](https://github.com/DitriXNew/EDT-MCP), поднимает **BSL Language Server**
по требованию, добавляет настройки на проект, правила для модели и навыки
SonarQube/GitLab.

Плагин включается только в выбранных проектах: сессия в каталоге с
`.dsh-1c.json` или в пути из `projects` файла `$DSH_HOME/dsh-1c.json`. В
остальных проектах в контексте остаётся только `edt_config`, которым проект и
включается.

В **linked git worktree** плагин поднимает отдельное окружение EDT
(`<worktree>/build/ws`, свой порт и логи), импортирует проекты и монтирует
`mcp__edt__*` туда; включённость и настройки наследуются от основного checkout.
Работает совместно с [dsh-git-worktree](https://github.com/LaoYueHanNi/dsh-git-worktree)
(`<repo>/.dsh/gitworktree/<branch>/`), `build/` не требует ручной настройки.
Управление — инструмент `edt_workspace`.

В workspace включаются plain text mode (DSH не рендерит embedded resource) и
`get_form_screenshot` с JVM-флагом `-DnativeFormBufferedLayoutRender=true`;
выключаются настройками `workspace.plainText` и `workspace.formScreenshots`.

## Установка

```text
plugin_manager { action: "install_bundle", target: "dsh-edt-projects" }
```

Нужны EDT 2026.1/2026.2 с установленным EDT-MCP. В основном checkout MCP-сервер
запускается вручную (по умолчанию `127.0.0.1:8765`); в worktree плагин находит
установку EDT сам или по `workspace.home`/`DSH_1C_EDT_HOME` и поднимает её.
Подробности и настройка — в
[README репозитория](https://github.com/pravets/dsh-edt-projects#readme).

## Что внутри

- `lib/` — хаб MCP-серверов: активация по проекту, монтаж по требованию
  (`edt_pin`), настройки на проект, правила для системного промпта, провайдер
  навыков; `repo.mjs`/`workspace.mjs`/`workspace-run.mjs` — определение worktree,
  подъём и остановка EDT-окружения в `build/`.
- `skills/` — навыки `edt-mcp-project-sonar` и `edt-mcp-project-gitlab`:
  оформление MR и замечания ревью через `glab`, замечания Sonar и гейт через
  `sonar`. Внутри включённого проекта включаются сами по маркерам репозитория
  (`.gitlab-ci.yml`, `sonar-project.properties`); ключ `enabled` в конфиге
  сильнее: `true`/`false` принудительно включает и выключает.
- `cordis.patch.yml` — состав серверов, который применяет менеджер плагинов:
  EDT, BSL Language Server по требованию, MCP-трекер и `v8std` (стандарты 1С и
  расшифровка диагностик EDT/BSL).

## Лицензия

MIT, см. [LICENSE](LICENSE).
