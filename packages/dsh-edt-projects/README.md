# dsh-edt-projects

Плагин [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) для
разработки на 1С: держит **1C:EDT** подключённым через
[EDT-MCP](https://github.com/DitriXNew/EDT-MCP), поднимает **BSL Language Server**
по требованию, добавляет настройки на проект, правила для модели и навыки
SonarQube/GitLab.

## Установка

```text
plugin_manager { action: "install_bundle", target: "dsh-edt-projects" }
```

Нужны EDT 2026.1/2026.2 с установленным EDT-MCP и запущенным MCP-сервером
(по умолчанию `127.0.0.1:8765`) — подробности и настройка в
[README репозитория](https://github.com/pravets/dsh-edt-projects#readme).

## Что внутри

- `lib/` — хаб MCP-серверов: монтаж по требованию (`mcp_pin`), настройки на
  проект, правила для системного промпта, провайдер навыков.
- `skills/` — навыки `edt-mcp-project-sonar` и `edt-mcp-project-gitlab`,
  включаются флагами `sonar.enabled` и `gitlab.enabled`.
- `cordis.patch.yml` — состав серверов, который применяет менеджер плагинов.

## Лицензия

MIT, см. [LICENSE](LICENSE).
