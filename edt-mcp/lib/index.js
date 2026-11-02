// Хаб MCP-серверов для DSH: подключение по требованию, настройки на проект
// и правила для модели.
//
// Зачем: каждый подключённый сервер отдаёт свои схемы инструментов в КАЖДЫЙ
// запрос к модели. EDT (99 инструментов) нужен постоянно, а BSL Language Server
// и система задач — эпизодически. Поэтому сервер помечается `lazy: true` и
// монтируется только по вызову `mcp_pin`; `mcp_unpin` возвращает контекст.
//
// Настройки: база из cordis.patch.yml <- $DSH_HOME/dsh-1c.json <- <cwd>/.dsh-1c.json.
// Файлы перечитываются на каждый pin/рендер промпта, поэтому правки применяются
// через mcp_reload без перезапуска DSH.
//
// Серверы описываются в config.servers (см. cordis.patch.yml):
//   edt:   { shared: true, transport: streamable-http, url, headers, lazy: false }
//   bsl:   { lazy: true, provision: true, root }   — jar берётся из env/кэша
//   tasks: { lazy: true, transport: streamable-http, url, headers }
//
// `shared: true` — одна копия на процесс (EDT один workspace); остальные серверы
// монтируются в скоуп агента, поэтому параллельные агенты в разных worktree
// получают каждый свой BSL LS со своим корнем.
export const name = 'mcp-hub';

export const inject = ['tools'];

import { watch } from 'node:fs';
import { bslAvailable, bslSettings, ensureJar, resolveBsl, startBslSupervisor } from './bsl.mjs';
import { projectConfigPath, resolveConfig, userConfigPath } from './config.mjs';
import { normalizeWiki, targetPathOf, writeDenialReason } from './wiki.mjs';

const HEADER = `## Работа с 1С через MCP

К этому профилю подключены MCP-серверы для работы с конфигурацией 1С. Правила:

- Структуру, метаданные и код ищи через MCP, а не файловым поиском. Чтение файлов и \`grep\` — запасной путь, когда MCP-инструмент недоступен или уже вернул ошибку.
- Проверяй утверждения о коде тем же инструментом, которым исследовал. Не выдавай непроверенное за проверенное.
- Если MCP-инструмент вернул ошибку, назови инструмент и текст ошибки. Не подменяй результат догадкой.
- Инструменты, меняющие состояние проекта (\`update_database\`, \`apply_quick_fix\`, удаление и переименование), вызывай только по явной просьбе пользователя.`;

const PIN_RULES = `
### Серверы по требованию

Часть серверов не подключена заранее, чтобы не занимать контекст их схемами. Посмотреть состояние — \`mcp_servers\`; подключить — \`mcp_pin(server)\`, отключить — \`mcp_unpin(server)\`.

- Подключай сервер сам, когда задача без него не решается: нужна диагностика или типы — \`bsl\`, нужны задачи или статусы — \`tasks\`.
- Для \`bsl\` передавай корень: \`mcp_pin("bsl", root: "<каталог конфигурации>")\`. Без корня берётся корень из настроек проекта, иначе каталог запуска DSH.
- Первый \`mcp_pin("bsl")\` может занять время: при отсутствии готового jar сервер скачивается (~130 МБ). Предупреди пользователя, если это долго.
- После \`mcp_unpin\` инструменты сервера исчезают из запроса. Не отключай сервер, пока работа с ним не закончена.
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
- Файлы вне рабочего каталога сервера дают \`File is not part of any registered workspace\`. Тогда переподключи сервер с нужным корнем: \`mcp_pin("bsl", root: "<каталог конфигурации>")\` — путь проекта видно в \`edt__list_projects\`.`;

const TASKS_RULES = `
### Система задач (\`tasks__*\`)

- Задачи, их статусы и комментарии — только через \`tasks__*\`. Не выдумывай номера задач, статусы и тексты комментариев.
- Состояние задачи меняй только по явной просьбе пользователя, а перед этим покажи, что именно изменится.`;

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
 * Текст правил под фактически настроенные серверы, их состояние и вики.
 * @param env окружение процесса (для тестов передаётся явно).
 * @param servers список записей { name, state }.
 * @param wikiRoots корни вики из normalizeWiki().
 */
export function buildRulesText(env = process.env, servers = [], wikiRoots = []) {
  const usable = new Set(servers.filter((s) => s.state !== 'unavailable').map((s) => s.name));
  const byEnv = servers.length === 0;
  const blocks = [HEADER];

  const edtUsable = usable.has('edt') || (byEnv && env.EDT_MCP_URL !== undefined);
  if (edtUsable) {
    blocks.push(EDT_EDIT_RULES, EDT_RULES);
  }
  if (usable.has('bsl') || (byEnv && (env.BSL_LS_JAR || env.BSL_MCP_URL))) blocks.push(BSL_RULES);
  if (usable.has('tasks') || (byEnv && env.TASKS_MCP_URL)) blocks.push(TASKS_RULES);

  const lazy = servers.filter((s) => s.state === 'lazy').map((s) => s.name);
  const unavailable = servers.filter((s) => s.state === 'unavailable').map((s) => s.name);
  if (lazy.length > 0 || unavailable.length > 0) {
    blocks.push(PIN_RULES);
    if (lazy.length > 0) blocks.push(`\nПодключены по требованию: ${lazy.join(', ')}.`);
    if (unavailable.length > 0) blocks.push(`\nНастроены не полностью (переменные окружения не заданы): ${unavailable.join(', ')}.`);
  }

  if (wikiRoots.length > 0) blocks.push(wikiRules(wikiRoots));

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
      shared: raw.shared === true,
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

/** Настройки BSL LS из окружения, перекрытые файлами настроек. */
function bslSettingsFor(effective) {
  const base = bslSettings(process.env);
  const fromFile = effective.config?.servers?.bsl ?? {};
  const pick = (key, fallback) => (fromFile[key] === undefined ? fallback : fromFile[key]);
  return {
    ...base,
    jar: pick('jar', base.jar),
    url: pick('url', base.url),
    version: pick('version', base.version),
    cacheDir: pick('cacheDir', base.cacheDir),
    java: pick('java', base.java),
    cwd: pick('cwd', base.cwd),
    root: pick('root', base.root),
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

/** Подпись конфигурации для обнаружения изменений при mcp_reload. */
const signatureOf = (entry, root) => JSON.stringify({ config: mountConfig(entry), root });

export async function apply(ctx, config) {
  const base = config ?? {};
  const globalState = new Map();
  const agentStates = new WeakMap();
  const watchedProjects = new Set();
  const loggedErrors = new Set();

  const cwdOf = (agent) => {
    try {
      return ctx.workingDirectory?.get?.(agent?.session) ?? process.cwd();
    } catch {
      return process.cwd();
    }
  };

  const effectiveFor = (agent) => {
    const effective = resolveConfig({ cwd: cwdOf(agent), env: process.env, base });
    for (const error of effective.errors) {
      if (loggedErrors.has(error)) continue;
      loggedErrors.add(error);
      ctx.logger?.warn?.(`mcp-hub: ${error}`);
    }
    return effective;
  };

  const entriesFor = (effective) => {
    const bsl = bslSettingsFor(effective);
    return normalizeServers(effective.config?.servers).map((entry) => {
      if (entry.raw.provision === true) {
        entry.provisioned = true;
        entry.transport = bsl.mcpUrl === undefined ? 'stdio' : 'streamable-http';
        if (!bslAvailable(bsl)) entry.unavailable = true;
      }
      return entry;
    });
  };

  const mapFor = (agent, shared) => {
    if (shared) return globalState;
    if (agent === undefined) return globalState;
    let map = agentStates.get(agent);
    if (map === undefined) {
      map = new Map();
      agentStates.set(agent, map);
    }
    return map;
  };

  const itemFor = (agent, entry) => {
    const map = mapFor(agent, entry.shared);
    let item = map.get(entry.name);
    if (item === undefined) {
      item = { entry, fiber: null, error: null, supervisor: null, signature: undefined };
      map.set(entry.name, item);
    } else {
      item.entry = entry;
    }
    return item;
  };

  const toolNamesOf = (serverName) => {
    const prefix = `mcp__${serverName}__`;
    try {
      return [...ctx.tools.view(undefined).visible.keys()].filter((toolName) => toolName.startsWith(prefix));
    } catch {
      return [];
    }
  };

  const snapshot = (agent) => {
    const effective = effectiveFor(agent);
    return entriesFor(effective).map((entry) => {
      const map = mapFor(agent, entry.shared);
      const item = map.get(entry.name);
      let value = 'lazy';
      if (entry.unavailable) value = 'unavailable';
      if (item?.fiber && !item.error) value = 'mounted';
      if (item?.error) value = 'failed';
      return {
        name: entry.name,
        state: value,
        scope: entry.shared ? 'shared' : agent === undefined ? 'global' : 'agent',
        transport: item?.supervisor ? 'lsp+mcp' : entry.transport,
        root: item?.supervisor?.root ?? entry.raw?.root,
        endpoint: item?.supervisor?.url ?? entry.raw?.url,
        tools: toolNamesOf(entry.name).length,
        error: item?.error,
      };
    });
  };

  const disposeItem = async (item) => {
    if (item.fiber) {
      await item.fiber.dispose().catch(() => {});
      item.fiber = null;
    }
    await item.supervisor?.stop();
    item.supervisor = null;
    item.error = null;
    item.signature = undefined;
  };

  const mount = async (agent, serverName, options = {}) => {
    const effective = effectiveFor(agent);
    const entries = entriesFor(effective);
    const entry = entries.find((candidate) => candidate.name === serverName);
    if (entry === undefined) {
      throw new Error(`unknown MCP server "${serverName}"; configured: ${entries.map((item) => item.name).join(', ') || 'none'}`);
    }
    if (entry.unavailable) {
      throw new Error(`MCP server "${serverName}" is configured but not available: environment for it is not set`);
    }

    const item = itemFor(agent, entry);
    const bsl = bslSettingsFor(effective);
    const root = options.root ?? entry.raw.root ?? bsl.root;

    if (item.fiber && !item.error) {
      const sameRoot = item.supervisor === null || item.supervisor?.root === root;
      if (sameRoot) return { already: true, tools: toolNamesOf(serverName).length };
      await disposeItem(item);
    }

    let resolvedEntry = entry;
    if (entry.provisioned) {
      try {
        const log = (message) => ctx.logger?.info?.(`mcp-hub(${serverName}): ${message}`);
        const mode = options.mode ?? bsl.mode;
        let resolved;
        if (bsl.mcpUrl !== undefined) {
          resolved = { transport: 'streamable-http', url: bsl.mcpUrl };
        } else if (mode === 'stdio') {
          resolved = await resolveBsl(bsl, { log });
        } else {
          const jar = await ensureJar(bsl, { log });
          const supervisor = await startBslSupervisor({ jar, java: bsl.java, root, port: bsl.port, log });
          item.supervisor = supervisor;
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
        await item.supervisor?.stop();
        item.supervisor = null;
        return { already: false, tools: 0, error: item.error };
      }
    }

    const McpClient = await import('@deepseek-ai/dsh-mcp-client');
    const scopeCtx = entry.shared || agent === undefined ? ctx : agent.ctx;
    const fiber = scopeCtx.plugin(McpClient, mountConfig(resolvedEntry));
    item.fiber = fiber;
    item.error = null;
    item.signature = signatureOf(resolvedEntry, root);
    try {
      await fiber;
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
    }
    return { already: false, tools: toolNamesOf(serverName).length, error: item.error };
  };

  const unmount = async (agent, serverName) => {
    const effective = effectiveFor(agent);
    const entry = entriesFor(effective).find((candidate) => candidate.name === serverName);
    const map = entry === undefined ? mapFor(agent, false) : mapFor(agent, entry.shared);
    const item = map.get(serverName);
    if (item === undefined || !item.fiber) return false;
    await disposeItem(item);
    return true;
  };

  /** Перечитывает настройки и перезапускает серверы, у которых изменился конфиг. */
  const reload = async (agent, serverName) => {
    const effective = effectiveFor(agent);
    const entries = entriesFor(effective);
    const targets = serverName === undefined ? entries : entries.filter((entry) => entry.name === serverName);
    if (serverName !== undefined && targets.length === 0) {
      throw new Error(`unknown MCP server "${serverName}"; configured: ${entries.map((item) => item.name).join(', ') || 'none'}`);
    }

    const changed = [];
    for (const entry of targets) {
      const map = mapFor(agent, entry.shared);
      const item = map.get(entry.name);
      if (item === undefined || !item.fiber) continue;
      const bsl = bslSettingsFor(effective);
      const root = entry.raw.root ?? bsl.root;
      const fresh = signatureOf(entry, root);
      if (fresh === item.signature) continue;
      await disposeItem(item);
      const result = await mount(agent, entry.name, {});
      changed.push({ name: entry.name, error: result.error });
    }
    return changed;
  };

  // Если плагин выгружают, процессы серверов не должны остаться висеть.
  ctx.effect(() => () => {
    for (const item of globalState.values()) item.supervisor?.stop();
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

  ctx.tools.register(
    textTool(
      'mcp_servers',
      'List MCP servers: state (mounted, lazy, unavailable, failed), scope, transport, tool count, workspace root and endpoint. Settings are read from $DSH_HOME/dsh-1c.json and <cwd>/.dsh-1c.json.',
      {},
      async (_args, exec) => {
        const rows = snapshot(exec?.agent).map((item) => {
          const extra = [
            item.root === undefined ? null : `root: ${item.root}`,
            item.endpoint === undefined ? null : `endpoint: ${item.endpoint}`,
            item.error === undefined ? null : `error: ${item.error}`,
          ]
            .filter(Boolean)
            .join(', ');
          return `${item.name}: ${item.state}, ${item.scope}, ${item.transport}, tools: ${item.tools}${extra ? `, ${extra}` : ''}`;
        });
        return { text: rows.length > 0 ? rows.join('\n') : 'No MCP servers are configured.' };
      },
    ),
  );

  const serverParam = {
    server: { type: 'string', description: 'Server name as reported by mcp_servers.', required: true },
    root: {
      type: 'string',
      description:
        'For a supervised server (bsl): workspace root to open, for example the configuration source directory. Defaults to servers.bsl.root from the settings files. Remounts the server when it differs.',
    },
    mode: { type: 'string', description: 'For a provisioned server: "hybrid" (LSP+MCP with workspace roots, default) or "stdio".' },
  };

  ctx.tools.register(
    textTool(
      'mcp_pin',
      'Mount a configured MCP server now, so its tools appear in this session. Re-reads the settings files first, so edited ports or roots apply without restarting DSH.',
      serverParam,
      async (args, exec) => {
        const result = await mount(exec?.agent, args.server, { root: args.root, mode: args.mode });
        if (result.error) throw new Error(`mcp_pin(${args.server}) failed: ${result.error}`);
        if (result.already) return { text: `${args.server} is already mounted (${result.tools} tools).` };
        return { text: `${args.server} mounted (${result.tools} tools). They are available from the next step.` };
      },
    ),
  );

  ctx.tools.register(
    textTool(
      'mcp_unpin',
      'Unmount a mounted MCP server and remove its tools from the session, freeing prompt space. Do not unmount a server while work with it is in progress.',
      { server: serverParam.server },
      async (args, exec) => {
        const wasMounted = await unmount(exec?.agent, args.server);
        return { text: wasMounted ? `${args.server} unmounted.` : `${args.server} was not mounted.` };
      },
    ),
  );

  ctx.tools.register(
    textTool(
      'mcp_reload',
      'Re-read the settings files ($DSH_HOME/dsh-1c.json and <cwd>/.dsh-1c.json) and restart mounted servers whose url, headers, command or root changed. Use after editing a settings file; no DSH restart needed.',
      { server: { type: 'string', description: 'Only this server; omit to check every configured server.' } },
      async (args, exec) => {
        const changed = await reload(exec?.agent, args.server);
        if (changed.length === 0) return { text: 'Настройки перечитаны, изменений в подключённых серверах нет.' };
        const rows = changed.map((item) => `${item.name}: ${item.error === undefined ? 'перезапущен' : `ошибка — ${item.error}`}`);
        return { text: `Настройки перечитаны:\n${rows.join('\n')}` };
      },
    ),
  );

  // --- наблюдение за файлами настроек ---
  const watchFile = (path) => {
    if (path === undefined || watchedProjects.has(path)) return;
    watchedProjects.add(path);
    try {
      const watcher = watch(path, { persistent: false }, () => {
        ctx.logger?.warn?.(`mcp-hub: настройки изменились (${path}). Примените их через mcp_reload.`);
      });
      watcher.on('error', () => {});
      ctx.effect(() => () => watcher.close());
    } catch {
      // Файла может ещё не быть — наблюдение не критично.
    }
  };

  watchFile(userConfigPath(process.env));
  watchFile(projectConfigPath(cwdOf(undefined)));

  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: 'mcp-rules:1c',
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS') + 1,
      interpolate: false,
      text: (context) => {
        const agent = context?.agent;
        const effective = effectiveFor(agent);
        const { roots } = normalizeWiki(effective.config?.wiki, { cwd: cwdOf(agent) });
        return buildRulesText(process.env, snapshot(agent), roots);
      },
    });
  });

  // Серверы без `lazy` подключаются на старте и ЖДУТСЯ: иначе их инструменты
  // опаздывают к первому запросу и модель видит пустой набор MCP.
  // Ошибка подключения не валит загрузку: сервер останется в состоянии failed,
  // а mcp-client продолжит реконнект в фоне.
  const eager = entriesFor(effectiveFor(undefined)).filter((entry) => !entry.lazy && !entry.unavailable);
  await Promise.all(
    eager.map(async (entry) => {
      try {
        await mount(undefined, entry.name);
      } catch (error) {
        ctx.logger?.warn?.(`mcp-hub: ${entry.name} failed to mount: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}
