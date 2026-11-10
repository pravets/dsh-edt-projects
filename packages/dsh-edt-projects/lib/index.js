// Хаб MCP-серверов для DSH: подключение по требованию, настройки на проект
// и правила для модели.
//
// Плагин стоит в профиле один раз, но активируется только в выбранных проектах:
// правила 1С, собственные инструменты и MCP-серверы появляются лишь там, где
// проект отмечен `.dsh-1c.json`, `enabled: true` или попадает в `projects`
// пользовательского файла (см. lib/enable.mjs). В остальных сессиях виден
// только `edt_config`, которым проект и включается.
//
// Зачем: каждый подключённый сервер отдаёт свои схемы инструментов в КАЖДЫЙ
// запрос к модели. EDT (99 инструментов) нужен постоянно в 1С-проекте, а BSL
// Language Server и система задач — эпизодически. Поэтому серверы монтируются в
// скоуп сессии: `lazy: true` — только по вызову `edt_pin`; незаленивые — при
// создании сессии включённого проекта. `edt_unpin` возвращает контекст.
//
// Настройки: база из cordis.patch.yml <- $DSH_HOME/dsh-1c.json <- <cwd>/.dsh-1c.json.
// Файлы перечитываются на каждый pin/рендер промпта и на каждый шаг (для
// включения на лету), поэтому правки применяются через edt_reload без
// перезапуска DSH.
//
// Git worktree: включённость и настройки наследуются от основного checkout, а
// окружение EDT поднимается своё — workspace в <worktree>/build/ws, свой порт и
// фоновый процесс (lib/workspace-run.mjs). Так параллельные worktree не делят
// один workspace EDT; основной checkout продолжает работать с ручным сервером.
//
// `shared: true` больше не работает: сервер всегда живёт в скоупе сессии, иначе
// его инструменты протекали бы в чужие проекты.
export const name = 'mcp-hub';

export const inject = ['tools', 'workingDirectory'];

/** Собственные инструменты плагина; префикс edt_ отделяет их от `mcp__edt__*`. */
export const TOOL_NAMES = ['edt_servers', 'edt_pin', 'edt_unpin', 'edt_reload', 'edt_config', 'edt_workspace'];

import { spawn } from 'node:child_process';
import { join, resolve as resolvePath, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';
import { bslAvailable, bslSettings, ensureJar, resolveBsl, startBslSupervisor } from './bsl.mjs';
import { projectConfigLoaded, projectConfigPath, resolveConfig, userConfigPath } from './config.mjs';
import { activationForPaths } from './enable.mjs';
import { normalizeWiki, targetPathOf, writeDenialReason } from './wiki.mjs';
import { normalizeTestTooling } from './tests.mjs';
import { initFile, upgradeFile } from './config-file.mjs';
import { stringifyConfig, validateConfig } from './schema.mjs';
import { createSkillsProvider } from './skills.mjs';
import { repositoriesUnder, repositoryAt, resolveContextCwd } from './repo.mjs';
import {
  BUILD_DIR,
  detectEdtHome,
  formatElapsed,
  isPortOpen,
  normalizeWorkspaceSettings,
  pickFreePort,
  pidAlive,
  prepareWorkspaceSnapshot,
  probeHealth,
  readPort,
  removeStamp,
  requiredJava,
  resolveEdtVm,
  resolveWorkspaceTarget,
  stateOf as workspaceState,
  tailFile,
  writePort,
  writeStamp,
} from './workspace.mjs';
import { cmdInit, cmdStop as stopWorkspaceNow, lockState } from './workspace-run.mjs';

const HEADER = `## Работа с 1С через MCP

К этому проекту подключены MCP-серверы для работы с конфигурацией 1С. Правила:

- Структуру, метаданные и код ищи через MCP, а не файловым поиском. Чтение файлов и \`grep\` — запасной путь, когда MCP-инструмент недоступен или уже вернул ошибку.
- Проверяй утверждения о коде тем же инструментом, которым исследовал. Не выдавай непроверенное за проверенное.
- Если MCP-инструмент вернул ошибку, назови инструмент и текст ошибки. Не подменяй результат догадкой.
- Инструменты, меняющие состояние проекта (\`update_database\`, \`apply_quick_fix\`, удаление и переименование), вызывай только по явной просьбе пользователя.`;

const PIN_RULES = `
### Серверы по требованию

Часть серверов не подключена заранее, чтобы не занимать контекст их схемами. Посмотреть состояние — \`edt_servers\`; подключить — \`edt_pin(server)\`, отключить — \`edt_unpin(server)\`.

- Подключай сервер сам, когда задача без него не решается: нужна диагностика или типы — \`bsl\`, нужны стандарты или расшифровка кода ошибки — \`v8std\`, нужны задачи или статусы — \`tasks\`.
- Для \`bsl\` передавай корень: \`edt_pin("bsl", root: "<каталог конфигурации>")\`. Без корня берётся корень из настроек проекта, иначе каталог запуска DSH.
- Первый \`edt_pin("bsl")\` может занять время: при отсутствии готового jar сервер скачивается (~130 МБ). Предупреди пользователя, если это долго.
- После \`edt_unpin\` инструменты сервера исчезают из запроса. Не отключай сервер, пока работа с ним не закончена.
- Если сервер помечен как не настроенный, не пытайся его подключить: скажи пользователю, чего не хватает.`;

const EDT_EDIT_RULES = `
### Правки конфигурации — только через EDT

Любую правку исходников 1С делай инструментами \`edt__*\`, а не файловыми (\`edit\`, \`write\`, \`pwsh\`): EDT держит модель проекта, и правка мимо него её рассинхронизирует.

- Модули: \`write_module_source\` (режимы replace / searchReplace / append / replaceMethod / insertBefore / insertAfter).
- Объекты и реквизиты: \`create_metadata\`, \`modify_metadata\`, \`rename_metadata_object\`, \`delete_metadata\`, \`adopt_metadata_object\`.
- Формы, СКД и динамические списки: \`create_metadata\` + \`modify_metadata\`, \`dcs\`.
- Макеты: \`modify_metadata\` с параметром \`template\`.
- Исправления по замечаниям контроля: \`apply_quick_fix\`.

Если подходящего инструмента EDT нет:

1. Не обходи ограничение молча. Остановись и скажи пользователю, какая операция нужна, что уже пробовал в EDT и чего не хватило.
2. Предложи оформить issue: https://github.com/DitriXNew/EDT-MCP/issues — с версией сервера (\`get_edt_version\`), именем нужного инструмента и примером задачи.
3. Править файл напрямую (\`edit\`/\`write\`) можно только по явному разрешению пользователя на этот конкретный случай; после такой правки предупреди, что модель EDT устарела, и предложи \`revalidate_objects\` или \`resync_to_disk\`.`;

const EDT_RULES = `
### EDT (\`edt__*\`)

- Проект, объекты, метаданные и поиск по коду: \`list_projects\` → \`get_metadata_details\` / \`search_in_code\` / \`get_module_structure\`.
- Замечания штатного контроля EDT — \`get_project_errors\`. Это проверка всего проекта и она медленнее точечных инструментов, поэтому для одного файла сначала смотри диагностику в BSL LS.
- Правки исходников — по правилам раздела «Правки конфигурации» выше.`;

const BSL_RULES = `
### BSL Language Server (\`bsl__*\`)

- \`analyze_file\` — диагностики одного файла. Это самый быстрый способ проверить свежую правку.
- \`type_info\` и \`global_member_info\` — свойства, методы и сигнатуры типов и глобального контекста платформы. Сверяйся с ними, а не по памяти.
- \`definition\`, \`find_references\`, \`call_hierarchy\`, \`hover\`, \`type_at_position\`, \`document_symbols\` — навигация. Перед изменением метода посмотри \`call_hierarchy\` или \`find_references\`.
- Позиции в \`line\`/\`character\` нумеруются с нуля.
- Файлы вне рабочего каталога сервера дают \`File is not part of any registered workspace\`. Тогда переподключи сервер с нужным корнем: \`edt_pin("bsl", root: "<каталог конфигурации>")\` — путь проекта видно в \`edt__list_projects\`.`;

const TASKS_RULES = `
### Система задач (\`tasks__*\`)

- Задачи, их статусы и комментарии — только через \`tasks__*\`. Не выдумывай номера задач, статусы и тексты комментариев.
- Состояние задачи меняй только по явной просьбе пользователя, а перед этим покажи, что именно изменится.`;

const V8STD_RULES = `
### Стандарты и ошибки (v8std)

v8std — внешняя база стандартов 1С и диагностик. Она объясняет правило и код ошибки, но не анализирует проект и не меняет код. Подключается по требованию: \`edt_pin("v8std")\`; в списке инструментов видна как \`mcp__v8std__*\`.

- EDT (\`get_project_errors\`) или BSL LS (\`analyze_file\`) вернул код — разреши его через \`v8std_explain_diagnostics\` (принимает \`acc 1245\`, \`АПК:361\`, \`bslls:AssignAliasFieldsInQuery\`, коды EDT), затем прочитай правило: \`v8std_get_page\`.
- Вопрос «как правильно по стандартам» или неясная тема — \`v8std_search\`; один метод BSL или фрагмент SDBL — \`v8std_explain_snippet\`. Это эвристика, а не подтверждённое нарушение.
- Переходы между стандартом и связанными диагностиками — \`v8std_get_related\`.
- В ответе называй точный код, заголовок, номер стандарта и ссылку. Не выдумывай номера стандартов: если v8std ничего не нашёл, так и скажи.
- Найденный текст — справка, а не приговор: проверку даёт EDT или BSL, v8std объясняет, что она означает.
- v8std только читает; правки исходников — через EDT-MCP, по правилам выше.`;

/** Блок про отдельное EDT-окружение worktree. */
function workspaceRules(workspace) {
  return `
### Окружение EDT в worktree

Сессия открыта в отдельном git worktree, поэтому у неё свой workspace EDT: ${workspace.wsDir}. Его поднимает плагин, отдельно от основного checkout.

- Первый запуск занимает 1–3 минуты, с импортом проектов — дольше. Готовность проверяй через \`edt_workspace\` (action=status): состояние \`ready\` и порт.
- Инструменты \`mcp__edt__*\` появляются после готовности сервера. Если вызов не удался из-за соединения — проверь статус, не перезапускай окружение самовольно.
- Правки исходников — через EDT по правилам выше; workspace EDT знает проекты этого worktree.
- Не удаляй \`${workspace.root}/build\` при живом EDT. Остановка — \`edt_workspace\` action=stop, перезапуск — action=restart.
- Логи: ${workspace.root}/build/logs (edt.log, edt-import.log, init.log).`;
}

/**
 * Собирает блок правил для вики.
 * @param roots результат normalizeWiki().roots
 */
function wikiRules(roots) {
  const paths = roots.map((root) => root.path).join(', ');
  const entries = roots
    .filter((root) => root.entry !== undefined)
    .map((root) => root.entry)
    .join(', ');
  const entryLine =
    entries === ''
      ? '- Если в корне вики есть `AGENTS.md` со схемой — начни с него.'
      : `- Начинай с ${entries} — это каталог страниц с краткими описаниями.`;
  return `
### Вики проекта

Документация команды по 1С лежит вне конфигурации: ${paths}. Это markdown-вики; правило «правки только через EDT» к ней не относится.

- Читай её обычными инструментами (\`grep\`, \`glob\`, \`read\`). Вики доступна только для чтения: \`edit\`/\`write\` по её путям будут отклонены.
${entryLine}
- Ищи по содержимому через \`grep\` (имена методов, коды ошибок, термины), а не перебором файлов.
- Ссылайся на найденное путём к файлу, чтобы пользователь мог открыть страницу.`;
}

/**
 * Блок правил YAxUnit: как проектировать решение, чтобы его можно было покрыть
 * юнит-тестами, и в какой проект писать тесты.
 */
function yaxunitRules(settings) {
  const hints = [];
  if (settings.path !== undefined) hints.push(`образец: ${settings.path}`);
  if (settings.project !== undefined) hints.push(`проект тестов: ${settings.project}`);
  const suffix = hints.length === 0 ? '' : ` (${hints.join(', ')})`;
  const target =
    settings.project === undefined
      ? ''
      : ` Тесты пиши в проект \`${settings.project}\`.`;
  return `
### Тестируемость (YAxUnit)

В проекте используется модуль юнит-тестирования YAxUnit${suffix}. При планировании задач закладывай тестируемость решения.

- Новую логику выноси в отдельные процедуры и функции без побочных эффектов; зависимости передавай параметрами, а не бери из глобального контекста.
- Обработчики форм, подписки и команды оставляй тонкими: они вызывают тестируемый слой.
- В плане задачи перечисли конкретные проверяемые случаи (успех, границы, ошибки) и модуль, куда пойдут тесты.${target}
- Внешние вызовы изолируй через Мокито.`;
}

/** Блок правил Vanessa: когда юнитов недостаточно, предлагать сценарии. */
function vanessaRules(settings) {
  const suffix = settings.path === undefined ? '' : ` (образец: ${settings.path})`;
  return `
### Сценарные тесты (Vanessa Automation)

В проекте используется Vanessa Automation${suffix}. Если функциональность нельзя или трудоёмко покрыть юнит-тестами, либо юнитов недостаточно (интеграция, обмен, интерфейс, печатные формы):

- Предложи пользователю 2–3 варианта сценария: что проверяем, шаги, ожидаемый результат, какие данные и настройки нужны.
- Не создавай сценарии молча: сначала согласуй набор с пользователем, потом реализуй.`;
}

/**
 * Текст правил под фактически настроенные серверы, их состояние, вики, тесты
 * и управляемое окружение worktree.
 * @param env окружение процесса (для тестов передаётся явно).
 * @param servers список записей { name, state }.
 * @param wikiRoots корни вики из normalizeWiki().
 * @param tests секция tests из настроек (флаги YAxUnit / Vanessa).
 * @param workspace описание окружения worktree (describeWorkspace) или undefined.
 */
export function buildRulesText(env = process.env, servers = [], wikiRoots = [], tests = {}, workspace = undefined) {
  const usable = new Set(servers.filter((s) => s.state !== 'unavailable').map((s) => s.name));
  const byEnv = servers.length === 0;
  const blocks = [HEADER];

  const edtUsable = usable.has('edt') || (byEnv && env.EDT_MCP_URL !== undefined);
  if (edtUsable) {
    blocks.push(EDT_EDIT_RULES, EDT_RULES);
  }
  if (usable.has('bsl') || (byEnv && (env.BSL_LS_JAR || env.BSL_MCP_URL))) blocks.push(BSL_RULES);
  if (usable.has('tasks') || (byEnv && env.TASKS_MCP_URL)) blocks.push(TASKS_RULES);
  if (usable.has('v8std') || (byEnv && env.V8STD_MCP_URL)) blocks.push(V8STD_RULES);
  if (workspace?.state === 'worktree') blocks.push(workspaceRules(workspace));

  const lazy = servers.filter((s) => s.state === 'lazy').map((s) => s.name);
  const unavailable = servers.filter((s) => s.state === 'unavailable').map((s) => s.name);
  if (lazy.length > 0 || unavailable.length > 0) {
    blocks.push(PIN_RULES);
    if (lazy.length > 0) blocks.push(`\nПодключены по требованию: ${lazy.join(', ')}.`);
    if (unavailable.length > 0) blocks.push(`\nНастроены не полностью (переменные окружения не заданы): ${unavailable.join(', ')}.`);
  }

  if (wikiRoots.length > 0) blocks.push(wikiRules(wikiRoots));

  const testTooling = normalizeTestTooling(tests);
  if (testTooling.yaxunit.enabled) blocks.push(yaxunitRules(testTooling.yaxunit));
  if (testTooling.vanessa.enabled) blocks.push(vanessaRules(testTooling.vanessa));

  return blocks.join('\n');
}

/** Нормализует config.servers в список записей; `disabled` серверы отбрасываются. */
export function normalizeServers(config = {}) {
  const result = [];
  for (const [name, raw] of Object.entries(config ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.disabled === true) continue;
    const transport = raw.transport ?? (raw.url === undefined ? 'stdio' : 'streamable-http');
    result.push({
      name,
      transport,
      lazy: raw.lazy === true,
      unavailable: raw.unavailable === true,
      raw,
    });
  }
  return result;
}

/**
 * Собирает конфиг для @deepseek-ai/dsh-mcp-client: остаётся только то, что
 * допускает схема выбранного транспорта, плюс его собственные поля.
 */
export function mountConfig(entry) {
  const raw = entry.raw ?? {};
  const common = {
    serverName: entry.name,
    toolCallTimeoutMs: raw.toolCallTimeoutMs,
    failOnStartupError: raw.failOnStartupError,
    maxInstructionBytes: raw.maxInstructionBytes,
    reconnect: raw.reconnect,
  };

  const specific =
    entry.transport === 'stdio'
      ? { transport: 'stdio', command: raw.command, args: raw.args, env: raw.env, cwd: raw.cwd }
      : { transport: 'streamable-http', url: raw.url, headers: raw.headers };

  const config = { ...common, ...specific };
  for (const key of Object.keys(config)) if (config[key] === undefined) delete config[key];
  return config;
}

/**
 * Настройки BSL LS из окружения, перекрытые файлами настроек.
 * @param fallbackRoot корень проекта: работе в worktree нужен его каталог,
 *   а не каталог процесса DSH. Относительный `servers.bsl.root` считается
 *   от него же.
 */
function bslSettingsFor(effective, fallbackRoot = process.cwd()) {
  const base = bslSettings(process.env);
  const fromFile = effective.config?.servers?.bsl ?? {};
  const pick = (key, fallback) => (fromFile[key] === undefined ? fallback : fromFile[key]);
  const rawRoot = pick('root', base.root);
  const root =
    typeof rawRoot !== 'string' || rawRoot.trim() === ''
      ? fallbackRoot
      : isAbsolute(rawRoot)
        ? rawRoot
        : resolvePath(fallbackRoot, rawRoot);
  return {
    ...base,
    jar: pick('jar', base.jar),
    url: pick('url', base.url),
    version: pick('version', base.version),
    cacheDir: pick('cacheDir', base.cacheDir),
    java: pick('java', base.java),
    cwd: pick('cwd', base.cwd) || fallbackRoot,
    root,
    port: pick('port', base.port),
    mode: pick('mode', base.mode),
    mcpUrl: pick('mcpUrl', base.mcpUrl),
    downloadAllowed: fromFile.download === false ? false : base.downloadAllowed,
  };
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', description: 'Human-readable result.' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

const textTool = (toolName, description, parameters, execute) => ({
  name: toolName,
  description,
  parameters,
  output: TEXT_OUTPUT,
  execute,
});

/** Подпись конфигурации для обнаружения изменений при edt_reload. */
const signatureOf = (entry, root) => JSON.stringify({ config: mountConfig(entry), root });

const activationReason = (activation) => {
  switch (activation.reason) {
    case 'enabled':
      return 'enabled: true в настройках';
    case 'disabled':
      return 'enabled: false в настройках';
    case 'project-file':
      return 'есть .dsh-1c.json проекта';
    case 'allowlist':
      return activation.inherited === true
        ? `путь в projects (${activation.entry}), наследовано из ${activation.path}`
        : `путь в projects (${activation.entry})`;
    default:
      return 'проект не выбран: нет .dsh-1c.json и его нет в projects';
  }
};

/**
 * Каталог, от которого считаются настройки проекта, корень BSL и пути вики.
 * Исходный каталог сессии (`session.header.cwd`) неизменяем, поэтому `cd`
 * внутри сессии не переключает проект; текущий каталог — только запасной путь,
 * когда исходный не записан.
 * @param agent агент с полем session (у подчинённых агентов его может не быть).
 * @param workingDirectory сервис `ctx.workingDirectory` (необязателен).
 */
export function sessionCwd(agent, workingDirectory) {
  const session = agent?.session;
  if (session === undefined) return process.cwd();
  const recorded = session.header?.cwd;
  if (typeof recorded === 'string' && recorded !== '') return recorded;
  try {
    const dir = workingDirectory?.get?.(session);
    return typeof dir === 'string' && dir !== '' ? dir : process.cwd();
  } catch {
    return process.cwd();
  }
}

export async function apply(ctx, config) {
  const base = config ?? {};
  const globalState = new Map();
  const agentStates = new WeakMap();
  const watchedProjects = new Set();
  const loggedErrors = new Set();
  let skillsControl;

  const originCwdOf = (agent) => sessionCwd(agent, ctx.workingDirectory);
  const workCwdOf = (agent) => {
    const session = agent?.session;
    if (session === undefined) return originCwdOf(agent);
    try {
      const dir = ctx.workingDirectory?.get?.(session);
      return typeof dir === 'string' && dir !== '' ? dir : originCwdOf(agent);
    } catch {
      return originCwdOf(agent);
    }
  };
  // Контекст сессии — эффективный каталог, если это worktree того же проекта.
  const cwdOf = (agent) =>
    resolveContextCwd({ origin: originCwdOf(agent), work: workCwdOf(agent) });

  /** Уникальные пути в порядке появления (для слоёв настроек и allowlist). */
  const uniquePaths = (values) => {
    const seen = new Set();
    const out = [];
    for (const value of values) {
      if (typeof value !== 'string' || value === '') continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  };

  /**
   * Контекст проекта для каталога сессии: репозитории, слои настроек,
   * активация и план EDT-окружения. Для worktree настройки берутся ещё и из
   * основного checkout, а активация наследуется от него же.
   */
  const projectContextForCwd = (cwd) => {
    const repositories = repositoriesUnder(cwd);
    // Порядок = порядок слияния: основной checkout слабее worktree, cwd сильнее всех.
    const paths = uniquePaths([...repositories.flatMap((repo) => [repo.mainRoot, repo.root]), cwd]);
    const effective = resolveConfig({ cwd, projectCwds: paths, env: process.env, base });
    for (const error of effective.errors) {
      if (loggedErrors.has(error)) continue;
      loggedErrors.add(error);
      ctx.logger?.warn?.(`mcp-hub: ${error}`);
    }
    const hasProjectFile = paths.some((dir) => projectConfigLoaded(dir));
    const activation = activationForPaths({ cwd, config: effective.config, hasProjectFile, paths });
    const enabledRepositories = repositories.filter(
      (repo) =>
        activationForPaths({
          cwd: repo.root,
          config: effective.config,
          hasProjectFile: projectConfigLoaded(repo.root) || projectConfigLoaded(repo.mainRoot),
          paths: [repo.root, repo.mainRoot],
        }).enabled,
    );
    // Если проект включён самим каталогом сессии (файл в task space), явного
    // списка включённых репозиториев может не быть — берём репозитории сессии.
    const workspaceRepositories =
      enabledRepositories.length > 0 ? enabledRepositories : activation.enabled ? repositories : [];
    const workspace = resolveWorkspaceTarget({
      cwd,
      config: effective.config,
      repositories: workspaceRepositories,
      env: process.env,
    });
    return { cwd, repositories, enabledRepositories, paths, effective, activation, workspace };
  };

  const contextFor = (agent) => {
    const base = projectContextForCwd(cwdOf(agent));
    const override = agent === undefined ? undefined : agentStates.get(agent)?.workspaceRoot;
    if (override === undefined) return base;

    const repo = repositoryAt(override);
    const repositories =
      repo === undefined
        ? [{ root: override, mainRoot: base.workspace?.mainRoot ?? override, isWorktree: true }]
        : [{ ...repo, isWorktree: true }];
    const workspace = resolveWorkspaceTarget({
      cwd: override,
      config: base.effective.config,
      repositories,
      env: process.env,
    });
    return { ...base, cwd: override, repositories, workspace, workspaceOverride: true };
  };
  const effectiveFor = (agent) => contextFor(agent).effective;

  /** Каталог, от которого считается корень BSL и относительный workspace.root. */
  const fallbackRootFor = (context) => {
    if (context.workspace.state === 'ok') return context.workspace.root;
    if (context.enabledRepositories.length > 0) return context.enabledRepositories[0].root;
    return context.cwd;
  };

  /** Дешёвая проверка живости: без tasklist, чтобы не звать её на каждом шаге. */
  const cheapAlive = (pid) => pidAlive(pid);

  /**
   * Описание окружения для правил, снапшота и инструмента edt_workspace.
   * `state` — включено ли управление ('worktree'/'off'/'error'),
   * `status` — фактическая фаза (absent/stopped/starting/ready/stale/failed).
   */
  const describeWorkspace = (plan, deps = {}) => {
    if (plan === undefined || plan.state === 'off') return { state: 'off', reason: plan?.reason };
    if (plan.state === 'error') {
      return { state: 'error', reason: plan.reason, message: plan.message, settings: plan.settings };
    }
    const current = workspaceState(plan.buildDir, deps);
    const phase = current.progress?.edt;
    return {
      state: 'worktree',
      status: current.label,
      root: plan.root,
      buildDir: plan.buildDir,
      wsDir: plan.wsDir,
      mainRoot: plan.mainRoot,
      port: current.port ?? undefined,
      pid: current.pid?.pid ?? undefined,
      phase: phase?.phase,
      since: phase?.since,
      detail: phase?.detail,
      warning: phase?.warning,
      imported: current.imported?.projects?.length,
      settings: plan.settings,
      warnings: plan.warnings ?? [],
      rootSource: plan.rootSource,
    };
  };

  const entriesFor = (context) => {
    const bsl = bslSettingsFor(context.effective, fallbackRootFor(context));
    const entries = normalizeServers(context.effective.config?.servers).map((entry) => {
      if (entry.raw.provision === true) {
        entry.provisioned = true;
        entry.transport = bsl.mcpUrl === undefined ? 'stdio' : 'streamable-http';
        if (!bslAvailable(bsl)) entry.unavailable = true;
      }
      return entry;
    });

    // В worktree EDT монтируется на порт поднятого для него окружения.
    if (context.workspace.state === 'ok') {
      const port = readPort(context.workspace.buildDir) ?? context.workspace.port;
      const edt = entries.find((entry) => entry.name === 'edt');
      if (edt !== undefined && Number.isInteger(port)) {
        edt.raw = { ...edt.raw, url: `http://127.0.0.1:${port}/mcp` };
      }
    }
    return entries;
  };

  /** Состояние активации одного агента (сессии): инструменты и смонтированные серверы. */
  const stateOf = (agent) => {
    let state = agentStates.get(agent);
    if (state === undefined) {
      state = { active: false, disposers: [], items: new Map() };
      agentStates.set(agent, state);
    }
    return state;
  };

  const mapFor = (agent) => (agent === undefined ? globalState : stateOf(agent).items);

  const itemFor = (agent, entry) => {
    const map = mapFor(agent);
    let item = map.get(entry.name);
    if (item === undefined) {
      item = { entry, fiber: null, error: null, supervisor: null, signature: undefined, suppressed: false };
      map.set(entry.name, item);
    } else {
      item.entry = entry;
    }
    return item;
  };

  const toolNamesOf = (agent, serverName) => {
    const prefix = `mcp__${serverName}__`;
    try {
      return ctx.tools
        .schemas(agent === undefined ? undefined : agent)
        .map((schema) => schema.name)
        .filter((toolName) => toolName.startsWith(prefix));
    } catch {
      return [];
    }
  };

  const snapshot = (agent, deps = {}) => {
    const context = contextFor(agent);
    const workspace = describeWorkspace(context.workspace, deps);
    return entriesFor(context).map((entry) => {
      const item = mapFor(agent).get(entry.name);
      let value = 'lazy';
      if (entry.unavailable) value = 'unavailable';
      if (item?.fiber && !item.error) value = 'mounted';
      if (item?.error) value = 'failed';
      // Пока EDT-окружение не готово, mounted с нулём инструментов выглядит
      // как поломка: показываем фазу подъёма.
      if (entry.name === 'edt' && item?.fiber && !item.error && workspace.state === 'worktree' && workspace.status !== 'ready') {
        value = workspace.status === 'failed' || workspace.status === 'stale' ? 'failed' : 'starting';
      }
      return {
        name: entry.name,
        state: value,
        scope: agent === undefined ? 'global' : 'session',
        transport: item?.supervisor ? 'lsp+mcp' : entry.transport,
        root: item?.supervisor?.root ?? entry.raw?.root,
        endpoint: item?.supervisor?.url ?? entry.raw?.url,
        tools: toolNamesOf(agent, entry.name).length,
        error: item?.error,
        workspace: entry.name === 'edt' ? workspace : undefined,
      };
    });
  };

  const disposeItem = async (item) => {
    if (item.fiber) {
      await item.fiber.dispose().catch(() => {});
      item.fiber = null;
    }
    await Promise.resolve(item.supervisor?.stop?.()).catch(() => {});
    item.supervisor = null;
    item.error = null;
    item.signature = undefined;
  };

  const mount = async (agent, serverName, options = {}) => {
    const context = contextFor(agent);
    const entries = entriesFor(context);
    const entry = entries.find((candidate) => candidate.name === serverName);
    if (entry === undefined) {
      throw new Error(`unknown MCP server "${serverName}"; configured: ${entries.map((item) => item.name).join(', ') || 'none'}`);
    }
    if (entry.unavailable) {
      throw new Error(`MCP server "${serverName}" is configured but not available: environment for it is not set`);
    }

    const item = itemFor(agent, entry);
    const bsl = bslSettingsFor(context.effective, fallbackRootFor(context));
    const root = options.root ?? entry.raw.root ?? bsl.root;

    if (item.fiber && !item.error) {
      const sameRoot = item.supervisor === null || item.supervisor?.root === root;
      if (sameRoot) {
        item.suppressed = false;
        return { already: true, tools: toolNamesOf(agent, serverName).length };
      }
      await disposeItem(item);
    }

    let resolvedEntry = entry;
    if (entry.provisioned) {
      try {
        const log = (message) => ctx.logger?.info?.(`mcp-hub(${serverName}): ${message}`);
        const warn = (message) => ctx.logger?.warn?.(`mcp-hub(${serverName}): ${message}`);
        const mode = options.mode ?? bsl.mode;
        let resolved;
        if (bsl.mcpUrl !== undefined) {
          resolved = { transport: 'streamable-http', url: bsl.mcpUrl };
        } else if (mode === 'stdio') {
          resolved = await resolveBsl(bsl, { log, warn });
        } else {
          const jar = await ensureJar(bsl, { log, warn });
          const supervisor = await startBslSupervisor({ jar, java: bsl.java, root, port: bsl.port, log });
          item.supervisor = supervisor;
          // Процесс BSL LS должен умереть вместе со скоупом агента, даже если
          // disposeItem не вызвали (сессия закрыта, плагин выгружен).
          if (agent !== undefined) {
            agent.ctx.effect(() => () => {
              Promise.resolve(supervisor.stop()).catch(() => {});
            });
          }
          resolved = { transport: 'streamable-http', url: supervisor.url };
        }
        resolvedEntry = {
          ...entry,
          transport: resolved.transport,
          raw: {
            ...resolved,
            toolCallTimeoutMs: entry.raw.toolCallTimeoutMs,
            failOnStartupError: entry.raw.failOnStartupError,
            reconnect: entry.raw.reconnect,
          },
        };
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
        await Promise.resolve(item.supervisor?.stop?.()).catch(() => {});
        item.supervisor = null;
        return { already: false, tools: 0, error: item.error };
      }
    }

    const McpClient = await import('@deepseek-ai/dsh-mcp-client');
    const scopeCtx = agent === undefined ? ctx : agent.ctx;
    const fiber = scopeCtx.plugin(McpClient, mountConfig(resolvedEntry));
    item.fiber = fiber;
    item.error = null;
    item.signature = signatureOf(resolvedEntry, root);
    item.suppressed = false;
    try {
      await fiber;
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
    }
    return { already: false, tools: toolNamesOf(agent, serverName).length, error: item.error };
  };

  const unmount = async (agent, serverName) => {
    const context = contextFor(agent);
    const entry = entriesFor(context).find((candidate) => candidate.name === serverName);
    const map = mapFor(agent);
    const item = map.get(serverName);
    if (item === undefined || !item.fiber) {
      if (entry !== undefined && item !== undefined) item.suppressed = true;
      return false;
    }
    await disposeItem(item);
    // Незаленивый сервер иначе смонтируется снова на следующем шаге.
    item.suppressed = true;
    return true;
  };

  /** Перечитывает настройки и перезапускает серверы, у которых изменился конфиг. */
  const reload = async (agent, serverName) => {
    const context = contextFor(agent);
    const entries = entriesFor(context);
    const targets = serverName === undefined ? entries : entries.filter((entry) => entry.name === serverName);
    if (serverName !== undefined && targets.length === 0) {
      throw new Error(`unknown MCP server "${serverName}"; configured: ${entries.map((item) => item.name).join(', ') || 'none'}`);
    }

    const changed = [];
    for (const entry of targets) {
      const item = mapFor(agent).get(entry.name);
      if (item === undefined || !item.fiber) continue;
      const freshRoot = entry.raw.root ?? bslSettingsFor(context.effective, fallbackRootFor(context)).root;
      const fresh = signatureOf(entry, freshRoot);
      if (fresh === item.signature) continue;
      await disposeItem(item);
      const result = await mount(agent, entry.name, {});
      changed.push({ name: entry.name, error: result.error });
    }
    return changed;
  };

  // Если плагин выгружают, процессы серверов не должны остаться висеть.
  ctx.effect(() => () => {
    for (const item of globalState.values()) Promise.resolve(item.supervisor?.stop?.()).catch(() => {});
  });

  // --- активация на проект ----------------------------------------------------
  const invalidateSkills = () => {
    try {
      skillsControl?.invalidate?.();
    } catch {
      // Инвалидация каталога — вспомогательная операция, не валим шаг.
    }
  };

  const watchFile = (path) => {
    if (path === undefined || watchedProjects.has(path)) return;
    watchedProjects.add(path);
    try {
      const watcher = watch(path, { persistent: false }, () => {
        invalidateSkills();
        ctx.logger?.warn?.(`mcp-hub: настройки изменились (${path}). Примените их через edt_reload.`);
      });
      watcher.on('error', () => {});
      ctx.effect(() => () => watcher.close());
    } catch {
      // Файла может ещё не быть — наблюдение не критично.
    }
  };

  // --- окружение EDT в worktree ----------------------------------------------
  const initializerPath = fileURLToPath(new URL('./workspace-run.mjs', import.meta.url));
  /** buildDir -> Promise подъёма (одна на процесс, чтобы не поднять два EDT). */
  const ensuring = new Map();
  /** buildDir -> { agents, settings, startedByUs } для остановки после последней сессии. */
  const workspaceSessions = new Map();

  const spawnInitializer = (root, action = 'init') => {
    try {
      const child = spawn(process.execPath, [initializerPath, action, '--root', root], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`mcp-hub: не удалось запустить ${action} окружения EDT: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const registerWorkspaceSession = (buildDir, agent, settings) => {
    let record = workspaceSessions.get(buildDir);
    if (record === undefined) {
      record = { agents: new Set(), settings, startedByUs: false };
      workspaceSessions.set(buildDir, record);
    }
    if (agent !== undefined) record.agents.add(agent);
    if (settings !== undefined) record.settings = settings;
    return record;
  };

  /** Фаза подъёма без pid (идёт импорт или старт GUI) тоже считается запуском. */
  const busyLaunching = (current, settings = {}) => {
    if (current.label === 'starting') return true;
    const phase = current.progress?.edt;
    if (phase?.phase === undefined || ['failed', 'ready'].includes(phase.phase)) return false;
    const updated = Date.parse(phase.updated ?? phase.since ?? '');
    if (Number.isNaN(updated)) return true;
    const budget = Math.max(settings.startTimeout ?? 1800, settings.importTimeout ?? 3600) * 1000 + 5 * 60_000;
    return Date.now() - updated < budget;
  };

  /** Убеждается, что фоновый run действительно начал работу (а не упал на lock). */
  const launchStarted = async (buildDir, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = workspaceState(buildDir, { alive: cheapAlive });
      const phase = current.progress?.edt?.phase;
      if (current.label === 'starting' || current.label === 'ready' || current.label === 'failed') return true;
      if (phase !== undefined && phase !== 'ready' && phase !== 'failed') return true;
      // run мог только взяться за lock, ещё не записав ни progress, ни pid.
      const runLock = lockState(join(buildDir, 'init-run.lock'));
      if (runLock.exists === true && runLock.stale === false) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };

  /**
   * Гарантирует подъём окружения: занимает порт, пишет снимок и запускает
   * фоновый init. Готовое/стартующее окружение только принимается.
   */
  const ensureWorkspace = async (agent, context = contextFor(agent), options = {}) => {
    const plan = context.workspace;
    if (plan?.state !== 'ok') return undefined;
    const key = plan.buildDir;
    const record = registerWorkspaceSession(key, agent, plan.settings);
    // После edt_workspace stop не поднимаем заново, пока не попросят init.
    if (record.suppressed === true && options.force !== true) {
      return workspaceState(key, { alive: cheapAlive });
    }
    const pending = ensuring.get(key);
    if (pending !== undefined) return pending;

    const promise = (async () => {
      let current = workspaceState(key, { alive: cheapAlive });
      if (current.label === 'failed' && options.force === true) {
        removeStamp(key, 'failed');
        current = workspaceState(key, { alive: cheapAlive });
      }
      if (current.label === 'ready') return current;
      if (current.label === 'failed') {
        // EDT мог подняться позже таймаута health: проверяем и принимаем.
        if (await probeHealth(current.port)) {
          removeStamp(key, 'failed');
          writeStamp(key, 'ready');
          return workspaceState(key, { alive: cheapAlive });
        }
        return current;
      }
      if (busyLaunching(current, plan.settings)) return current;
      if (current.label === 'stale') removeStamp(key, 'ready');

      try {
        let port = readPort(key);
        if (port !== null && (await isPortOpen(port))) {
          // Кто-то уже слушает порт: если это наш MCP-сервер (DSH перезапустили,
          // маркер потерялся), принимаем его и не поднимаем второй EDT на тот же
          // workspace.
          if (await probeHealth(port)) {
            removeStamp(key, 'failed');
            writeStamp(key, 'ready');
            return workspaceState(key, { alive: cheapAlive });
          }
          port = null;
        }
        if (port === null) {
          port = await pickFreePort(plan.settings.ports);
          writePort(key, port);
        }
        const workspaceSnapshot = prepareWorkspaceSnapshot({
          root: plan.root,
          mainRoot: plan.mainRoot,
          settings: plan.settings,
        });
        if (options.import === true) workspaceSnapshot.forceImport = true;
        const initLog = join(key, 'logs', 'init.log');
        const code = await cmdInit(plan.root, {}, { snapshot: workspaceSnapshot });
        if (code !== 0) {
          const tail = tailFile(initLog);
          return {
            ...workspaceState(key, { alive: cheapAlive }),
            launchError: `init завершился с кодом ${code}${tail === null ? '' : `: ${tail}`}`,
          };
        }
        record.startedByUs = true;
        if (!(await launchStarted(key))) {
          const tail = tailFile(initLog);
          return {
            ...workspaceState(key, { alive: cheapAlive }),
            launchError: `run не стартовал${tail === null ? '' : `: ${tail}`}`,
          };
        }
        return workspaceState(key, { alive: cheapAlive });
      } catch (error) {
        ctx.logger?.warn?.(`mcp-hub: окружение EDT не поднялось: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    })().finally(() => ensuring.delete(key));

    ensuring.set(key, promise);
    return promise;
  };

  /** Снимает сессию с окружения; после последней — останавливает поднятое нами EDT. */
  const releaseWorkspaceSession = (agent) => {
    for (const [buildDir, record] of workspaceSessions) {
      if (!record.agents.delete(agent)) continue;
      if (record.agents.size > 0) continue;
      workspaceSessions.delete(buildDir);
      if (record.startedByUs !== true) continue;
      if (record.settings?.stopOnSessionEnd === false) continue;
      spawnInitializer(resolvePath(buildDir, '..'), 'stop');
    }
  };

  const activate = async (agent) => {
    const state = stateOf(agent);
    if (state.active) return;
    state.active = true;
    const context = contextFor(agent);
    for (const definition of [serversTool(), pinTool(), unpinTool(), reloadTool(), workspaceTool()]) {
      state.disposers.push(agent.ctx.tools.register(definition));
    }
    for (const dir of context.paths) watchFile(projectConfigPath(dir));

    // Окружение поднимается до монтирования edt: нужен порт для адреса.
    if (context.workspace.state === 'ok') {
      try {
        const launched = await ensureWorkspace(agent, context);
        if (launched?.launchError !== undefined) ctx.logger?.warn?.(`mcp-hub: ${launched.launchError}`);
      } catch (error) {
        ctx.logger?.warn?.(`mcp-hub: окружение EDT не поднялось: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const entry of entriesFor(context)) {
      if (entry.lazy || entry.unavailable) continue;
      try {
        await mount(agent, entry.name);
      } catch (error) {
        ctx.logger?.warn?.(`mcp-hub: ${entry.name} failed to mount: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const deactivate = async (agent) => {
    const state = agentStates.get(agent);
    if (state === undefined || !state.active) return;
    state.active = false;
    state.workspaceRoot = undefined;
    for (const dispose of state.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Инструменты могли быть уже сняты выгрузкой скоупа.
      }
    }
    for (const item of state.items.values()) await disposeItem(item);
    state.items.clear();
    releaseWorkspaceSession(agent);
  };

  /**
   * Сводит состояние сессии с текущими настройками: включает проект на лету
   * после edt_config init/правки файла и выключает после enabled:false.
   */
  const reconcile = async (agent) => {
    if (agent === undefined) return;
    const context = contextFor(agent);
    const state = agentStates.get(agent);
    if (!context.activation.enabled) {
      await deactivate(agent);
      return;
    }
    if (state === undefined || !state.active) {
      await activate(agent);
      return;
    }

    if (context.workspace.state === 'ok') {
      const launched = await ensureWorkspace(agent, context);
      if (launched?.launchError !== undefined) ctx.logger?.warn?.(`mcp-hub: ${launched.launchError}`);
      // Порт появился после init — адрес edt изменился, перемонтируем.
      try {
        await reload(agent, 'edt');
      } catch (error) {
        ctx.logger?.warn?.(`mcp-hub: не удалось обновить адрес EDT: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await reconcile(agent);
    } catch (error) {
      ctx.logger?.warn?.(`mcp-hub: активация для сессии не удалась: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      await reconcile(agent);
    } catch (error) {
      ctx.logger?.warn?.(`mcp-hub: активация для сессии не удалась: ${error instanceof Error ? error.message : String(error)}`);
    }
    return next();
  });

  ctx.on('agent/disposed', ({ agent }) => {
    releaseWorkspaceSession(agent);
  });

  ctx.effect(() => () => {
    ensuring.clear();
    workspaceSessions.clear();
  });

  // --- вики: чтение разрешено, запись отклоняется ---
  ctx.tools.guard((exec) => {
    const target = targetPathOf(exec);
    if (target === undefined) return undefined;
    const cwd = cwdOf(exec.agent);
    const { roots } = normalizeWiki(effectiveFor(exec.agent).config?.wiki, { cwd });
    if (roots.length === 0) return undefined;
    return writeDenialReason(exec.name, target, roots, { cwd });
  });

  const serversTool = () =>
    textTool(
      'edt_servers',
      'List MCP servers of the 1C plugin: state (mounted, lazy, unavailable, failed), scope, transport, tool count, workspace root and endpoint, plus the worktree EDT environment when one is managed. Settings are read from $DSH_HOME/dsh-1c.json and <cwd>/.dsh-1c.json.',
      {},
      async (_args, exec) => {
        const rows = snapshot(exec?.agent, { alive: cheapAlive }).map((item) => {
          const workspace = item.workspace;
          const extra = [
            item.root === undefined ? null : `root: ${item.root}`,
            item.endpoint === undefined ? null : `endpoint: ${item.endpoint}`,
            workspace?.state === 'worktree' ? `worktree: ${workspace.status}${workspace.port === undefined ? '' : ` port ${workspace.port}`}` : null,
            workspace?.state === 'error' ? `worktree: ${workspace.message}` : null,
            item.error === undefined ? null : `error: ${item.error}`,
          ]
            .filter(Boolean)
            .join(', ');
          return `${item.name}: ${item.state}, ${item.scope}, ${item.transport}, tools: ${item.tools}${extra ? `, ${extra}` : ''}`;
        });
        return { text: rows.length > 0 ? rows.join('\n') : 'No MCP servers are configured.' };
      },
    );

  const serverParam = {
    server: { type: 'string', description: 'Server name as reported by edt_servers.', required: true },
    root: {
      type: 'string',
      description:
        'For a supervised server (bsl): workspace root to open, for example the configuration source directory. Defaults to servers.bsl.root from the settings files. Remounts the server when it differs.',
    },
    mode: { type: 'string', description: 'For a provisioned server: "hybrid" (LSP+MCP with workspace roots, default) or "stdio".' },
  };

  const pinTool = () =>
    textTool(
      'edt_pin',
      'Mount a configured MCP server now, so its tools appear in this session. Re-reads the settings files first, so edited ports or roots apply without restarting DSH.',
      serverParam,
      async (args, exec) => {
        const result = await mount(exec?.agent, args.server, { root: args.root, mode: args.mode });
        if (result.error) throw new Error(`edt_pin(${args.server}) failed: ${result.error}`);
        if (result.already) return { text: `${args.server} is already mounted (${result.tools} tools).` };
        return { text: `${args.server} mounted (${result.tools} tools). They are available from the next step.` };
      },
    );

  const unpinTool = () =>
    textTool(
      'edt_unpin',
      'Unmount a mounted MCP server and remove its tools from the session, freeing prompt space. Do not unmount a server while work with it is in progress.',
      { server: serverParam.server },
      async (args, exec) => {
        const wasMounted = await unmount(exec?.agent, args.server);
        return { text: wasMounted ? `${args.server} unmounted.` : `${args.server} was not mounted.` };
      },
    );

  const reloadTool = () =>
    textTool(
      'edt_reload',
      'Re-read the settings files ($DSH_HOME/dsh-1c.json and <cwd>/.dsh-1c.json) and restart mounted servers whose url, headers, command or root changed. Use after editing a settings file; no DSH restart needed.',
      { server: { type: 'string', description: 'Only this server; omit to check every configured server.' } },
      async (args, exec) => {
        invalidateSkills();
        const changed = await reload(exec?.agent, args.server);
        if (changed.length === 0) return { text: 'Настройки перечитаны, изменений в подключённых серверах нет.' };
        const rows = changed.map((item) => `${item.name}: ${item.error === undefined ? 'перезапущен' : `ошибка — ${item.error}`}`);
        return { text: `Настройки перечитаны:\n${rows.join('\n')}` };
      },
    );

  /** План окружения с необязательным переопределением корня (параметр root). */
  const workspacePlanFor = (exec, rootOverride) => {
    const context = contextFor(exec?.agent);
    if (rootOverride === undefined || rootOverride === '') return { context, plan: context.workspace };
    const settings = context.workspace?.settings ?? normalizeWorkspaceSettings(context.effective.config?.workspace, process.env);
    const root = isAbsolute(rootOverride) ? rootOverride : resolvePath(context.cwd, rootOverride);
    const buildDir = join(root, BUILD_DIR);
    return {
      context,
      plan: {
        state: 'ok',
        settings,
        root,
        buildDir,
        wsDir: join(buildDir, 'ws'),
        mainRoot: context.workspace?.mainRoot,
        warnings: context.workspace?.warnings ?? [],
      },
    };
  };

  const workspaceText = (plan, deps = {}) => {
    const info = describeWorkspace(plan, deps);
    if (info.state === 'off') {
      const why =
        info.reason === 'disabled'
          ? 'workspace.enabled=false'
          : 'основной checkout: окружение поднимается только в git worktree';
      return `Автоподъём EDT-окружения выключен — ${why}.`;
    }
    if (info.state === 'error') return `EDT-окружение недоступно: ${info.message}`;

    const lines = [
      `Worktree: ${info.root}`,
      `Workspace EDT: ${info.wsDir}`,
      `Состояние: ${info.status}${info.port === undefined ? '' : `, порт ${info.port}`}${info.pid === undefined ? '' : `, pid ${info.pid}`}`,
    ];
    if (info.phase !== undefined) {
      const elapsed = info.since === undefined ? '' : ` (${formatElapsed(info.since)})`;
      lines.push(`Фаза: ${info.phase}${elapsed}${info.detail === undefined ? '' : ` — ${info.detail}`}`);
    }
    if (info.imported !== undefined) lines.push(`Импортировано проектов: ${info.imported}`);
    const home = detectEdtHome(info.settings, { platform: process.platform, env: process.env });
    const required = requiredJava(home.home, { platform: process.platform });
    const vm = resolveEdtVm(info.settings, home.home, { platform: process.platform, env: process.env });
    lines.push(`EDT: ${home.home ?? 'не найден'}${home.error === undefined ? '' : ` — ${home.error}`}`);
    lines.push(`Java: ${vm ?? 'авто'}${required.major === undefined ? '' : ` (EDT требует ${required.major})`}`);
    if (info.status !== 'ready') {
      if (home.mcpBundle === false) {
        lines.push('EDT-MCP: по файлам не подтверждён; готовность проверит /health');
      } else if (Array.isArray(home.mcpEvidence) && home.mcpEvidence.length > 0) {
        lines.push(`EDT-MCP: ${home.mcpEvidence[0]}`);
      }
    }
    const importMode = info.settings.import;
    lines.push(`Импорт проектов: ${importMode === true ? 'да' : importMode === false ? 'нет' : 'авто (если workspace пуст)'}`);
    lines.push(`Plain text: ${info.settings.plainText === false ? 'нет' : 'да'}; скриншоты форм: ${info.settings.formScreenshots === false ? 'нет' : 'да'}`);
    if (info.warning !== undefined) {
      const warning = info.warning;
      const memory = warning.used === undefined ? '' : ` (${warning.used}/${warning.total} MB)`;
      lines.push(`! импорт шёл на пределе памяти${memory} — поднимите workspace.xmxImport`);
    }
    for (const warning of info.warnings) lines.push(`! ${warning}`);
    lines.push(`Логи: ${join(info.buildDir, 'logs')}; импорт: ${join(info.wsDir, '.metadata', '.log')}`);
    return lines.join('\n');
  };

  const workspaceTool = () =>
    textTool(
      'edt_workspace',
      'Manage the EDT workspace of this git worktree: action=status reports where build/ws is, whether EDT is ready, its port, phase and warnings; init starts it (or retries a failed start); stop stops the EDT process; restart stops and starts again, optionally re-importing projects; import imports EDT projects while EDT is stopped (it runs in the background).',
      {
        action: {
          type: 'string',
          description: 'status | init | stop | restart | import',
          enum: ['status', 'init', 'stop', 'restart', 'import'],
        },
        root: { type: 'string', description: 'Worktree root to manage; defaults to the project worktree of this session.' },
        import: { type: 'boolean', description: 'For init/restart: import EDT projects even if the workspace already has some.' },
      },
      async (args, exec) => {
        const action = args.action ?? 'status';
        const { context, plan } = workspacePlanFor(exec, args.root);
        if (action === 'status') return { text: workspaceText(plan, { alive: (pid) => pidAlive(pid, ['1cedt']) }) };

        if (plan === undefined || plan.state !== 'ok') {
          throw new Error(`EDT-окружение недоступно: ${plan?.message ?? workspaceText(plan)}`);
        }
        // root=… не только поднимает окружение, но и становится контекстом
        // сессии: entriesFor подменит URL edt на порт этого workspace.
        if (args.root !== undefined && args.root !== '') stateOf(exec?.agent).workspaceRoot = plan.root;
        const record = registerWorkspaceSession(plan.buildDir, exec?.agent, plan.settings);

        if (action === 'stop') {
          const result = await stopWorkspaceNow(plan.root);
          record.suppressed = true;
          return { text: result.stopped ? `EDT остановлен (pid ${result.pid}).` : `EDT не остановлен: ${result.reason}.` };
        }

        record.suppressed = false;
        if (action === 'restart' || action === 'import') {
          if (action === 'import') {
            const current = workspaceState(plan.buildDir, { alive: cheapAlive });
            if (current.label === 'ready' || busyLaunching(current)) {
              throw new Error('EDT запущен: импорт возможен только при остановленном EDT. Используйте action=restart с import: true.');
            }
          }
          if (action === 'restart') await stopWorkspaceNow(plan.root);
        }

        const forceImport = args.import === true || action === 'import';
        const result = await ensureWorkspace(exec?.agent, { ...context, workspace: plan }, { force: true, import: forceImport });
        if (result === undefined) throw new Error('Не удалось запустить подъём окружения: смотрите логи build/logs.');
        if (result.launchError !== undefined) throw new Error(`${result.launchError}\n\n${workspaceText(plan)}`);
        if (result.label === 'failed') {
          const info = describeWorkspace(plan, { alive: cheapAlive });
          const warning = info.warning;
          const memory =
            warning === undefined
              ? ''
              : `\n! импорт шёл на пределе памяти${warning.used === undefined ? '' : ` (${warning.used}/${warning.total} MB)`} — поднимите workspace.xmxImport`;
          throw new Error(`EDT-окружение не поднялось: ${info.detail ?? 'см. build/logs/edt.log'}${memory}`);
        }
        if (result.label === 'ready') {
          return { text: `EDT уже готов (порт ${result.port ?? '-'}).\n\n${workspaceText(plan)}` };
        }
        const headline =
          action === 'import'
            ? 'Импорт проектов запущен в фоне.'
            : action === 'restart'
              ? 'EDT перезапускается в фоне.'
              : 'Подъём EDT-окружения запущен в фоне.';
        return {
          text: [
            headline,
            'Первый запуск занимает 1–3 минуты (с импортом дольше). Проверяйте готовность через action=status.',
            workspaceText(plan),
          ].join('\n'),
        };
      },
    );

  const configTool = () =>
    textTool(
      'edt_config',
      'Manage dsh-edt-projects settings: which projects enable the 1C plugin (enabled/projects), wiki paths, test tooling, MCP servers and bundled skills. action=show prints the effective settings, their sources, whether this project is enabled and validation warnings; init creates the project .dsh-1c.json (which enables the plugin for it); upgrade adds only missing keys, keeping your values; validate reports type errors and unknown keys.',
      {
        action: {
          type: 'string',
          description: 'show | init | upgrade | validate',
          required: true,
          enum: ['show', 'init', 'upgrade', 'validate'],
        },
        scope: { type: 'string', description: 'project (default) or user ($DSH_HOME/dsh-1c.json).', enum: ['project', 'user'] },
        dryRun: { type: 'boolean', description: 'For upgrade: only report what would be added (default true).' },
      },
      async (args, exec) => {
        const cwd = cwdOf(exec?.agent);
        const path = args.scope === 'user' ? userConfigPath(process.env) : projectConfigPath(cwd);
        if (path === undefined) throw new Error('edt_config: cannot resolve the settings path');

        if (args.action === 'show') {
          const context = contextFor(exec?.agent);
          const effective = context.effective;
          const { errors, warnings } = validateConfig(effective.config);
          const activation = context.activation;
          const workspace = describeWorkspace(context.workspace, { alive: cheapAlive });
          const origin = originCwdOf(exec?.agent);
          const dirsLine =
            origin === context.cwd
              ? `Каталог: ${context.cwd}`
              : `Каталог: исходный ${origin}, рабочий ${context.cwd}${context.workspaceOverride === true ? ' (через edt_workspace root)' : ''}`;
          const workspaceLine =
            workspace.state === 'worktree'
              ? `EDT-окружение worktree: ${workspace.status}, порт ${workspace.port ?? '-'}, ${workspace.root}`
              : workspace.state === 'error'
                ? `EDT-окружение worktree: ошибка — ${workspace.message}`
                : 'EDT-окружение worktree: выключено (поднимается только в git worktree)';
          const head = [
            `Проект: ${activation.enabled ? 'включён' : 'выключен'} — ${activationReason(activation)}`,
            dirsLine,
            `Источники: ${effective.sources.length > 0 ? effective.sources.join(', ') : 'только cordis.patch.yml'}`,
            workspaceLine,
            `Действующие настройки:\n${stringifyConfig(effective.config)}`,
          ];
          if (errors.length > 0) head.push(`Ошибки:\n${errors.map((line) => `  ✗ ${line}`).join('\n')}`);
          if (warnings.length > 0) head.push(`Предупреждения:\n${warnings.map((line) => `  ! ${line}`).join('\n')}`);
          return { text: head.join('\n\n') };
        }

        if (args.action === 'init') {
          const created = initFile(path);
          if (created.status === 'exists') return { text: `${path} уже существует — используйте action=upgrade, чтобы дополнить его.` };
          if (created.status === 'error') throw new Error(`edt_config init: ${created.error}`);
          invalidateSkills();
          const hint =
            args.scope === 'user'
              ? 'Дальше впишите пути проектов в projects, чтобы включить плагин там.'
              : 'Проект включён со следующего шага: появятся правила 1С и mcp__edt__*.';
          return { text: `Создан ${path}. ${hint}` };
        }

        if (args.action === 'upgrade') {
          const dryRun = args.dryRun !== false;
          const result = upgradeFile(path, { dryRun });
          if (result.status === 'error') throw new Error(`edt_config upgrade: ${result.error}`);
          if (result.status === 'noop') return { text: `${path}: актуален, добавлять нечего.` };
          if (!dryRun) invalidateSkills();
          const lines = [`${path}: ${dryRun ? 'будет добавлено' : 'добавлено'} ${result.added.length} ключ(ей):`];
          for (const key of result.added) lines.push(`  + ${key}`);
          if (dryRun) lines.push('Это был предварительный просмотр. Повторите с dryRun: false, чтобы записать.');
          for (const warning of result.warnings) lines.push(`  ! ${warning}`);
          for (const error of result.errors) lines.push(`  ✗ ${error}`);
          return { text: lines.join('\n') };
        }

        // validate
        const effective = effectiveFor(exec?.agent);
        const { errors, warnings } = validateConfig(effective.config);
        if (errors.length === 0 && warnings.length === 0) return { text: 'Настройки корректны, неизвестных ключей нет.' };
        const lines = [];
        for (const error of errors) lines.push(`  ✗ ${error}`);
        for (const warning of warnings) lines.push(`  ! ${warning}`);
        return { text: lines.join('\n') };
      },
    );

  // edt_config остаётся глобальным: это единственная точка входа, которой
  // включают проект, поэтому он не может зависеть от активации.
  ctx.tools.register(configTool());

  // --- навыки, поставляемые с бандлом ---
  // Провайдер глобальный, но отдаёт навыки только для включённого проекта;
  // инвалидация каталога при правке настроек — через control.invalidate().
  ctx.inject(['skills'], (inner) => {
    inner.skills.registerProvider((control) => {
      skillsControl = control;
      return createSkillsProvider({
        // Навыки гейтятся тем же контекстом проекта, что и инструменты: в
        // worktree включённость наследуется от основного checkout.
        resolveConfig: (cwd) => projectContextForCwd(cwd ?? process.cwd()).effective.config,
        isEnabled: (cwd) => projectContextForCwd(cwd ?? process.cwd()).activation.enabled,
        logger: ctx.logger,
      });
    });
  });

  watchFile(userConfigPath(process.env));
  watchFile(projectConfigPath(cwdOf(undefined)));

  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: 'mcp-rules:1c',
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS') + 1,
      interpolate: false,
      text: (context) => {
        const agent = context?.agent;
        // В выключенном проекте секция пустая: renderPrompt выбрасывает её,
        // поэтому в промпте не остаётся ни строчки про 1С.
        if (agent === undefined) return '';
        const projectContext = contextFor(agent);
        if (!projectContext.activation.enabled) return '';
        const { roots } = normalizeWiki(projectContext.effective.config?.wiki, { cwd: projectContext.cwd });
        return buildRulesText(
          process.env,
          snapshot(agent, { alive: cheapAlive }),
          roots,
          projectContext.effective.config?.tests,
          describeWorkspace(projectContext.workspace, { alive: cheapAlive }),
        );
      },
    });
  });
}
