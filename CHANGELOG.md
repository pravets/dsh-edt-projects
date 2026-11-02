# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

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
