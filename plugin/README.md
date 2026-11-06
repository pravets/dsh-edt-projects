# dsh-edt-projects

Бандл DeepSeek Harness для работы с проектами 1С: **1C:EDT** через
[EDT-MCP](https://github.com/DitriXNew/EDT-MCP) всегда подключён, **BSL Language
Server** и MCP-сервер системы задач — по требованию (`mcp_pin`). В пакет входят
правила выбора инструментов для модели и навыки SonarQube и GitLab.

## Установка

```
plugin_manager { action: "install_bundle", target: "dsh-edt-projects" }
```

После установки серверы `edt`, `bsl` и `tasks` настраиваются файлами
`$DSH_HOME/dsh-1c.json` (пользовательские) и `<проект>/.dsh-1c.json`
(проектные) — ключи описаны в
[README репозитория](https://github.com/pravets/dsh-edt-projects#readme).

## Что внутри

- `lib/` — хаб MCP-серверов: монтаж по требованию, правила для системного
  промпта, настройки на проект, провайдер навыков.
- `skills/` — навыки `edt-mcp-project-sonar` и `edt-mcp-project-gitlab`,
  включаются флагами конфига.
- `cordis.patch.yml` — состав серверов, который применяет менеджер плагинов.

## Лицензия

MIT, см. [LICENSE](LICENSE).
