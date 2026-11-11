// Схема файла настроек dsh-1c.json: значения по умолчанию, известные ключи,
// апгрейд и валидация.
//
// Правила апгрейда: существующие значения не меняются, недостающие ключи
// добавляются, неизвестные ключи сохраняются, версия поднимается.
export const CONFIG_VERSION = 4;

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
  // Окружение EDT для git worktree: workspace в <worktree>/build/ws и свой
  // MCP-сервер на своём порту. Поднимается только в linked worktree.
  workspace: {
    enabled: true,
    root: '',
    home: { win32: '', linux: '' },
    vm: '',
    xmxIde: '6g',
    xmxImport: '8g',
    import: 'auto',
    importTimeout: 3600,
    startTimeout: 1800,
    projects: [],
    ports: { min: 20000, max: 39999 },
    stopOnSessionEnd: true,
    // MCP-инструменты EDT-MCP, которые нам нужны в worktree: plain text
    // вместо embedded resource (DSH их не рендерит) и скриншоты форм.
    plainText: true,
    formScreenshots: true,
  },
  tests: {
    yaxunit: { enabled: false, path: '', project: '' },
    vanessa: { enabled: false, path: '' },
  },
  // `enabled` у навыков намеренно не входит в defaults: отсутствие ключа —
  // это «включить по маркерам репозитория», и upgrade не должен его дописывать.
  sonar: { projectKey: '' },
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
  'servers.*.transport': { type: 'string', description: 'Транспорт: stdio или streamable-http.' },
  'servers.*.disabled': { type: 'boolean', description: 'Не монтировать сервер.' },
  'servers.*.unavailable': { type: 'boolean', description: 'Сервер описан, но не настроен (нет переменных окружения).' },
  'servers.*.command': { type: 'string', description: 'Команда запуска для stdio-сервера.' },
  'servers.*.args': { type: 'array', description: 'Аргументы команды stdio-сервера.' },
  'servers.*.env': { type: 'object', description: 'Переменные окружения stdio-сервера.' },
  'servers.*.cwd': { type: 'string', description: 'Рабочий каталог stdio-сервера.' },
  'servers.*.maxInstructionBytes': { type: 'number', description: 'Предел текста инструкций сервера.' },
  'servers.*.lazy': { type: 'boolean', description: 'Не подключать на старте, только по edt_pin.' },
  'servers.*.shared': { type: 'boolean', description: 'Устарело: серверы всегда монтируются в скоупе сессии.' },
  'servers.*.provision': { type: 'boolean', description: 'Параметры запуска добираются на edt_pin.' },
  'servers.*.toolCallTimeoutMs': { type: 'number', description: 'Таймаут вызова инструмента.' },
  'servers.*.failOnStartupError': { type: 'boolean', description: 'Падать, если стартовое подключение не удалось.' },
  'servers.*.reconnect': { type: 'object', description: 'Политика переподключения.' },
  'servers.*.reconnect.enabled': { type: 'boolean', description: 'Включено ли переподключение.' },
  'servers.*.reconnect.initialDelayMs': { type: 'number', description: 'Начальная задержка переподключения, мс.' },
  'servers.*.reconnect.maxDelayMs': { type: 'number', description: 'Максимальная задержка переподключения, мс.' },
  'servers.*.reconnect.maxAttempts': { type: 'number', description: 'Максимум попыток переподключения.' },
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
  'workspace': { type: 'object', description: 'Окружение EDT для git worktree: workspace в <worktree>/build/ws и свой MCP-порт.' },
  'workspace.enabled': { type: 'boolean', description: 'Поднимать ли EDT-окружение в worktree автоматически.' },
  'workspace.root': { type: 'string', description: 'Корень окружения относительно корня worktree; пусто — сам worktree.' },
  'workspace.home': { type: 'object', description: 'Каталог установки 1C:EDT по платформам.' },
  'workspace.home.win32': { type: 'string', description: 'Каталог 1C:EDT в Windows (где 1cedt.exe).' },
  'workspace.home.linux': { type: 'string', description: 'Каталог 1C:EDT в Linux (где 1cedt).' },
  'workspace.vm': { type: 'string', description: 'Java для EDT; пусто — автопоиск jdk-full-17 рядом с установкой.' },
  'workspace.xmxIde': { type: 'string', description: 'Xmx для запуска EDT, например 6g.' },
  'workspace.xmxImport': { type: 'string', description: 'Xmx для 1cedtcli при импорте проектов.' },
  'workspace.import': { type: 'string', description: 'Импорт проектов в новый workspace: true, false или auto.' },
  'workspace.importTimeout': { type: 'number', description: 'Таймаут импорта 1cedtcli, секунды.' },
  'workspace.startTimeout': { type: 'number', description: 'Ожидание готовности MCP-сервера EDT, секунды.' },
  'workspace.projects': { type: 'array', description: 'Шаблоны EDT-проектов для импорта; пусто — автопоиск каталогов с .project.' },
  'workspace.ports': { type: 'object', description: 'Диапазон портов MCP-сервера EDT.' },
  'workspace.ports.min': { type: 'number', description: 'Нижняя граница диапазона портов.' },
  'workspace.ports.max': { type: 'number', description: 'Верхняя граница диапазона портов.' },
  'workspace.stopOnSessionEnd': { type: 'boolean', description: 'Останавливать EDT, когда закрылась последняя сессия на этом worktree.' },
  'workspace.plainText': { type: 'boolean', description: 'Plain text mode EDT-MCP вместо embedded resource (DSH их не рендерит).' },
  'workspace.formScreenshots': { type: 'boolean', description: 'Включить get_form_screenshot и JVM-флаг nativeFormBufferedLayoutRender.' },
  'tests.yaxunit.enabled': { type: 'boolean', description: 'Включить правила тестируемости YAxUnit.' },
  'tests.yaxunit.path': { type: 'string', description: 'Каталог тестов как образец стиля.' },
  'tests.yaxunit.project': { type: 'string', description: 'EDT-проект, в который писать тесты.' },
  'tests.vanessa.enabled': { type: 'boolean', description: 'Включить правила сценарных тестов Vanessa.' },
  'tests.vanessa.path': { type: 'string', description: 'Каталог сценариев как образец стиля.' },
  sonar: { type: 'object', description: 'Навык SonarQube: enabled и ключ проекта.' },
  'sonar.enabled': {
    type: 'boolean',
    description: 'Включить навык SonarQube: не задан — авто по sonar-project.properties, projectKey или серверу sonarqube; true — принудительно вкл., false — принудительно выкл.',
  },
  'sonar.projectKey': { type: 'string', description: 'Ключ проекта Sonar; пусто — берётся из sonar-project.properties.' },
  gitlab: { type: 'object', description: 'Навык GitLab (glab): enabled.' },
  'gitlab.enabled': {
    type: 'boolean',
    description: 'Включить навык GitLab: не задан — авто по .gitlab-ci.yml и .gitlab/merge_request_templates; true — принудительно вкл., false — принудительно выкл.',
  },
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
    // До версии 4 init всегда писал `enabled: false` навыкам, поэтому false из
    // старого файла — это прежнее «по умолчанию», а не осознанный выбор.
    // Убираем ключ, чтобы навык включился по маркерам; явный false в файле
    // версии 4 и новее сохраняется как есть.
    for (const key of ['gitlab', 'sonar']) {
      if (isPlainObject(filled[key]) && filled[key].enabled === false) {
        delete filled[key].enabled;
        const path = `${key}.enabled`;
        const index = added.indexOf(path);
        if (index !== -1) added.splice(index, 1);
      }
    }
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
    // У import три допустимых значения (true, false, "auto") — своя проверка ниже.
    if (path === 'workspace.import') return;
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

  if (isPlainObject(config.servers)) {
    for (const [name, server] of Object.entries(config.servers)) {
      if (!isPlainObject(server)) continue;
      if (Array.isArray(server.args) && !server.args.every((item) => typeof item === 'string')) {
        errors.push(`servers.${name}.args: ожидался массив строк`);
      }
    }
  }

  if (isPlainObject(config.workspace)) {
    const workspace = config.workspace;
    if (workspace.import !== undefined && ![true, false, 'auto'].includes(workspace.import)) {
      errors.push(`workspace.import: ожидалось true, false или "auto", получено ${JSON.stringify(workspace.import)}`);
    }
    if (workspace.projects !== undefined) {
      if (!Array.isArray(workspace.projects)) errors.push('workspace.projects: ожидался массив шаблонов');
      else if (!workspace.projects.every((item) => typeof item === 'string')) errors.push('workspace.projects: ожидался массив строк');
    }
    for (const key of ['importTimeout', 'startTimeout']) {
      const value = workspace[key];
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) errors.push(`workspace.${key}: ожидалось положительное число`);
    }
    if (isPlainObject(workspace.ports)) {
      const { min, max } = workspace.ports;
      if (min !== undefined && (!Number.isInteger(min) || min < 1 || min > 65535)) errors.push('workspace.ports.min: ожидался порт 1..65535');
      if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 65535)) errors.push('workspace.ports.max: ожидался порт 1..65535');
      if (Number.isInteger(min) && Number.isInteger(max) && min > max) errors.push('workspace.ports: min больше max');
    }
  }

  return { errors, warnings };
}

/** Сериализация с отступом 2 и переводом строки в конце — как принято в репозитории. */
export function stringifyConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
