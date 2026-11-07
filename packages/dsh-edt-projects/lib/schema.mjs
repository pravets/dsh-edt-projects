// Схема файла настроек dsh-1c.json: значения по умолчанию, известные ключи,
// апгрейд и валидация.
//
// Правила апгрейда: существующие значения не меняются, недостающие ключи
// добавляются, неизвестные ключи сохраняются, версия поднимается.
export const CONFIG_VERSION = 2;

/** Значения по умолчанию для нового файла. Пустые строки и массивы
 *  нормализаторы игнорируют, поэтому init ничего не включает сам по себе.
 *  `enabled` намеренно не входит в defaults: `upgrade` не должен выключать
 *  проект, который включён самим фактом своего `.dsh-1c.json`. */
export const DEFAULTS = {
  version: CONFIG_VERSION,
  projects: [],
  wiki: { paths: [], entry: '' },
  servers: {
    edt: { url: 'http://127.0.0.1:8765/mcp' },
    bsl: { root: '' },
    tasks: { url: '' },
  },
  tests: {
    yaxunit: { enabled: false, path: '', project: '' },
    vanessa: { enabled: false, path: '' },
  },
  sonar: { enabled: false, projectKey: '' },
  gitlab: { enabled: false },
};

/** Известные ключи: путь -> описание и тип. Используются валидацией и README. */
export const KNOWN = {
  version: { type: 'number', description: 'Версия схемы настроек.' },
  enabled: { type: 'boolean', description: 'Включить или выключить плагин для этого проекта (сильнее файла проекта и списка projects).' },
  projects: { type: 'array', description: 'Каталоги проектов, где плагин включён (пользовательский файл).' },
  'wiki.paths': { type: 'array', description: 'Каталоги вики (абсолютные или относительно проекта).' },
  'wiki.entry': { type: 'string', description: 'Входная точка вики, например wiki/index.md.' },
  'servers': { type: 'object', description: 'Настройки MCP-серверов по именам.' },
  'servers.*.url': { type: 'string', description: 'Адрес MCP-сервера (streamable-http).' },
  'servers.*.headers': { type: 'object', description: 'Заголовки запросов, например Authorization.' },
  'servers.*.root': { type: 'string', description: 'Корень рабочего пространства (для bsl).' },
  'servers.*.lazy': { type: 'boolean', description: 'Не подключать на старте, только по edt_pin.' },
  'servers.*.shared': { type: 'boolean', description: 'Устарело: серверы всегда монтируются в скоупе сессии.' },
  'servers.*.provision': { type: 'boolean', description: 'Параметры запуска добираются на edt_pin.' },
  'servers.*.toolCallTimeoutMs': { type: 'number', description: 'Таймаут вызова инструмента.' },
  'servers.*.failOnStartupError': { type: 'boolean', description: 'Падать, если стартовое подключение не удалось.' },
  'servers.*.reconnect': { type: 'object', description: 'Политика переподключения.' },
  'servers.bsl.jar': { type: 'string', description: 'Готовый jar BSL Language Server.' },
  'servers.bsl.url': { type: 'string', description: 'Прямой URL на jar вместо GitHub.' },
  'servers.bsl.version': { type: 'string', description: 'Тег релиза BSL LS, например v1.0.7.' },
  'servers.bsl.cacheDir': { type: 'string', description: 'Каталог кэша jar.' },
  'servers.bsl.java': { type: 'string', description: 'Команда java.' },
  'servers.bsl.cwd': { type: 'string', description: 'Рабочий каталог процесса BSL LS.' },
  'servers.bsl.port': { type: 'number', description: 'Порт встроенного веб-сервера BSL LS.' },
  'servers.bsl.mode': { type: 'string', description: 'hybrid (LSP+MCP) или stdio.' },
  'servers.bsl.mcpUrl': { type: 'string', description: 'Адрес уже запущенного BSL LS по HTTP.' },
  'servers.bsl.download': { type: 'boolean', description: 'Разрешено ли скачивание jar.' },
  'tests.yaxunit.enabled': { type: 'boolean', description: 'Включить правила тестируемости YAxUnit.' },
  'tests.yaxunit.path': { type: 'string', description: 'Каталог тестов как образец стиля.' },
  'tests.yaxunit.project': { type: 'string', description: 'EDT-проект, в который писать тесты.' },
  'tests.vanessa.enabled': { type: 'boolean', description: 'Включить правила сценарных тестов Vanessa.' },
  'tests.vanessa.path': { type: 'string', description: 'Каталог сценариев как образец стиля.' },
  'sonar.enabled': { type: 'boolean', description: 'Включить навык SonarQube.' },
  'sonar.projectKey': { type: 'string', description: 'Ключ проекта Sonar; пусто — берётся из sonar-project.properties.' },
  'gitlab.enabled': { type: 'boolean', description: 'Включить навык GitLab (glab).' },
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Совпадает ли путь с шаблоном вида `servers.*.url`. */
function matchesPattern(path, pattern) {
  const left = path.split('.');
  const right = pattern.split('.');
  if (left.length !== right.length) return false;
  return right.every((part, index) => part === '*' || part === left[index]);
}

/** Известен ли ключ (точное совпадение или шаблон с `*`). */
export function isKnownPath(path) {
  if (KNOWN[path] !== undefined) return true;
  return Object.keys(KNOWN).some((pattern) => pattern.includes('*') && matchesPattern(path, pattern));
}

function walkLeaves(value, prefix, visit) {
  if (!isPlainObject(value)) {
    visit(prefix, value);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    visit(prefix, value);
    return;
  }
  for (const [key, child] of entries) {
    walkLeaves(child, prefix === '' ? key : `${prefix}.${key}`, visit);
  }
}

/** Добавляет недостающие ключи из defaults в target; возвращает список путей. */
function fillMissing(target, defaults, prefix, added) {
  const result = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(defaults)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const current = result[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      result[key] = fillMissing(current, value, path, added);
    } else if (current === undefined) {
      // Контейнер не попадает в список: сообщаем только о листовых ключах.
      if (isPlainObject(value)) result[key] = fillMissing({}, value, path, added);
      else {
        result[key] = value;
        added.push(path);
      }
    }
  }
  return result;
}

/** Упорядочивает ключи: сначала известные по схеме, затем остальные как были. */
function orderBySchema(value, defaults) {
  if (!isPlainObject(value)) return value;
  const ordered = {};
  for (const key of Object.keys(defaults ?? {})) {
    if (value[key] !== undefined) ordered[key] = orderBySchema(value[key], defaults[key]);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key in ordered) continue;
    ordered[key] = isPlainObject(child) ? orderBySchema(child, undefined) : child;
  }
  return ordered;
}

/**
 * Планирует обновление существующего конфига до текущей схемы.
 * Существующие значения не меняются, недостающие ключи добавляются.
 * @returns {{ config: object, added: string[], version: { from: number|undefined, to: number } }}
 */
export function planUpgrade(existing) {
  const source = isPlainObject(existing) ? existing : {};
  const from = typeof source.version === 'number' ? source.version : undefined;

  const added = [];
  const filled = fillMissing(source, DEFAULTS, '', added);
  if (from !== undefined && from < CONFIG_VERSION) {
    filled.version = CONFIG_VERSION;
    if (!added.includes('version')) added.push('version');
  }

  return {
    config: orderBySchema(filled, DEFAULTS),
    added,
    version: { from, to: CONFIG_VERSION },
  };
}

/** Валидация: ошибки типов и предупреждения о неизвестных ключах. */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(config)) {
    errors.push('конфиг должен быть JSON-объектом');
    return { errors, warnings };
  }

  walkLeaves(config, '', (path, value) => {
    if (!isKnownPath(path)) {
      warnings.push(`неизвестный ключ: ${path}`);
      return;
    }
    const expected = KNOWN[path]?.type ?? Object.entries(KNOWN).find(([pattern]) => pattern.includes('*') && matchesPattern(path, pattern))?.[1]?.type;
    if (expected === undefined) return;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (expected === 'object' && actual !== 'object') errors.push(`${path}: ожидался объект, получено ${actual}`);
    else if (expected !== 'object' && actual !== expected) errors.push(`${path}: ожидался ${expected}, получено ${actual}`);
  });

  if (isPlainObject(config.wiki) && config.wiki.paths !== undefined && Array.isArray(config.wiki.paths)) {
    if (!config.wiki.paths.every((item) => typeof item === 'string')) errors.push('wiki.paths: ожидался массив строк');
  }

  if (config.projects !== undefined && !Array.isArray(config.projects)) {
    errors.push(`projects: ожидался массив путей, получено ${typeof config.projects}`);
  } else if (Array.isArray(config.projects) && !config.projects.every((item) => typeof item === 'string')) {
    errors.push('projects: ожидался массив строк');
  }

  return { errors, warnings };
}

/** Сериализация с отступом 2 и переводом строки в конце — как принято в репозитории. */
export function stringifyConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
