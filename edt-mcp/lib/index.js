// Хаб MCP-серверов для DSH: подключение по требованию и правила для модели.
//
// Зачем: каждый подключённый сервер отдаёт свои схемы инструментов в КАЖДЫЙ
// запрос к модели. EDT (99 инструментов) нужен постоянно, а BSL Language Server
// и система задач — эпизодически. Поэтому сервер помечается `lazy: true` и
// монтируется только по вызову `mcp_pin`; `mcp_unpin` возвращает контекст.
//
// Серверы описываются в config.servers (см. cordis.patch.yml):
//   edt:   { transport: streamable-http, url, headers, toolCallTimeoutMs, lazy: false }
//   bsl:   { lazy: true, provision: true }   — jar берётся из env/кэша, иначе качается
//   tasks: { lazy: true, transport: streamable-http, url, headers }
//
// Лишние ключи (например url у stdio-сервера) отбрасываются: схема
// @deepseek-ai/dsh-mcp-client — это union из двух строгих вариантов.
export const name = 'mcp-hub';

export const inject = ['tools'];

import { bslAvailable, bslSettings, ensureJar, resolveBsl, startBslSupervisor } from './bsl.mjs';

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
- Для \`bsl\` передавай корень: \`mcp_pin("bsl", root: "<каталог конфигурации>")\`. Без корня сервер видит только каталог запуска DSH.
- Первый \`mcp_pin("bsl")\` может занять время: при отсутствии готового jar сервер скачивается (~130 МБ). Предупреди пользователя, если это долго.
- После \`mcp_unpin\` инструменты сервера исчезают из запроса. Не отключай сервер, пока работа с ним не закончена.
- Если сервер помечен как не настроенный, не пытайся его подключить: скажи пользователю, чего не хватает.`;

const EDT_RULES = `
### EDT (\`edt__*\`)

- Проект, объекты, метаданные и поиск по коду: \`list_projects\` → \`get_metadata_details\` / \`search_in_code\` / \`get_module_structure\`.
- Замечания штатного контроля EDT — \`get_project_errors\`. Это проверка всего проекта и она медленнее точечных инструментов, поэтому для одного файла сначала смотри диагностику в BSL LS.
- Правки исходников — по правилам раздела «Правки конфигурации» выше.`;

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
 * Текст правил под фактически настроенные серверы и их состояние.
 * @param env окружение процесса (для тестов передаётся явно).
 * @param servers список записей { name, state }.
 */
export function buildRulesText(env = process.env, servers = []) {
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

export async function apply(ctx, config) {
  const bsl = bslSettings(process.env);
  const entries = normalizeServers(config?.servers).map((entry) => {
    // provision: параметры запуска добираются на mcp_pin (для BSL LS — скачивание jar).
    if (entry.raw.provision === true) {
      entry.provisioned = true;
      entry.transport = bsl.mcpUrl === undefined ? 'stdio' : 'streamable-http';
      if (!bslAvailable(bsl)) entry.unavailable = true;
    }
    return entry;
  });
  const state = new Map(entries.map((entry) => [entry.name, { entry, fiber: null, error: null }]));

  const toolNamesOf = (serverName) => {
    const prefix = `mcp__${serverName}__`;
    try {
      return [...ctx.tools.view(undefined).visible.keys()].filter((toolName) => toolName.startsWith(prefix));
    } catch {
      return [];
    }
  };

  const snapshot = () =>
    [...state.values()].map((item) => {
      let value = 'lazy';
      if (item.entry.unavailable) value = 'unavailable';
      if (item.fiber && !item.error) value = 'mounted';
      if (item.error) value = 'failed';
      return {
        name: item.entry.name,
        state: value,
        transport: item.supervisor ? 'lsp+mcp' : item.entry.transport,
        root: item.supervisor?.root,
        endpoint: item.supervisor?.url,
        tools: toolNamesOf(item.entry.name).length,
      };
    });

  const mount = async (serverName, options = {}) => {
    const item = state.get(serverName);
    if (item === undefined) {
      throw new Error(`unknown MCP server "${serverName}"; configured: ${[...state.keys()].join(', ') || 'none'}`);
    }
    if (item.entry.unavailable) {
      throw new Error(`MCP server "${serverName}" is configured but not available: environment for it is not set`);
    }
    // Смена корня — повод перезапустить provisioned-сервер: BSL LS получает
    // рабочие каталоги только при старте LSP-сессии.
    if (item.fiber && options.root !== undefined && item.supervisor !== null && item.supervisor?.root !== options.root) {
      await item.fiber.dispose().catch(() => {});
      item.fiber = null;
      await item.supervisor?.stop();
      item.supervisor = null;
    }
    if (item.fiber && !item.error) return { already: true, tools: toolNamesOf(serverName).length };

    // provisioned-сервер сам добирает параметры запуска: скачивает jar BSL LS
    // и, если нужно, поднимает его в гибридном режиме — LSP объявляет корни,
    // MCP отдаётся по HTTP на том же процессе. Ошибка — понятный отказ.
    let entry = item.entry;
    if (entry.provisioned) {
      try {
        const log = (message) => ctx.logger?.info?.(`mcp-hub(${serverName}): ${message}`);
        let resolved;
        const root = options.root ?? bsl.root;
        const mode = options.mode ?? bsl.mode;
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
        entry = {
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
    const fiber = ctx.plugin(McpClient, mountConfig(entry));
    item.fiber = fiber;
    item.error = null;
    try {
      await fiber;
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
    }
    return { already: false, tools: toolNamesOf(serverName).length, error: item.error };
  };

  const unmount = async (serverName) => {
    const item = state.get(serverName);
    if (item === undefined) {
      throw new Error(`unknown MCP server "${serverName}"; configured: ${[...state.keys()].join(', ') || 'none'}`);
    }
    if (!item.fiber) return false;
    await item.fiber.dispose();
    item.fiber = null;
    item.error = null;
    // Процесс BSL LS живёт под нашим управлением: гасим его вместе с клиентом.
    await item.supervisor?.stop();
    item.supervisor = null;
    return true;
  };

  // Если плагин выгружают, процессы серверов не должны остаться висеть.
  ctx.effect(() => () => {
    for (const item of state.values()) item.supervisor?.stop();
  });

  ctx.tools.register(
    textTool(
      'mcp_servers',
      'List MCP servers of this profile: whether each is mounted, lazy (mount with mcp_pin) or unavailable, how many tools it contributes, and for a supervised server its workspace root and endpoint.',
      {},
      async () => {
        const rows = snapshot().map((item) => {
          const extra = [item.root === undefined ? null : `root: ${item.root}`, item.endpoint === undefined ? null : `endpoint: ${item.endpoint}`]
            .filter(Boolean)
            .join(', ');
          return `${item.name}: ${item.state}, ${item.transport}, tools: ${item.tools}${extra ? `, ${extra}` : ''}`;
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
        'For a supervised server (bsl): workspace root to open, for example the configuration source directory. Remounts the server when it differs from the current root.',
    },
    mode: { type: 'string', description: 'For a provisioned server: "hybrid" (LSP+MCP with workspace roots, default) or "stdio".' },
  };

  ctx.tools.register(
    textTool(
      'mcp_pin',
      'Mount a configured MCP server now, so its tools appear in this session. Use when the task needs that server (diagnostics, types, task tracker). For bsl pass root with the configuration directory.',
      serverParam,
      async (args) => {
        const result = await mount(args.server, { root: args.root, mode: args.mode });
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
      serverParam,
      async (args) => {
        const wasMounted = await unmount(args.server);
        return { text: wasMounted ? `${args.server} unmounted.` : `${args.server} was not mounted.` };
      },
    ),
  );

  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: 'mcp-rules:1c',
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS') + 1,
      interpolate: false,
      text: () => buildRulesText(process.env, snapshot()),
    });
  });

  // Серверы без `lazy` подключаются на старте и ЖДУТСЯ: иначе их инструменты
  // опаздывают к первому запросу и модель видит пустой набор MCP.
  // Ошибка подключения не валит загрузку: сервер останется в состоянии failed,
  // а mcp-client продолжит реконнект в фоне.
  const eager = [...state.values()].filter((item) => !item.entry.lazy && !item.entry.unavailable);
  await Promise.all(
    eager.map(async (item) => {
      try {
        await mount(item.entry.name);
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
        ctx.logger?.warn?.(`mcp-hub: ${item.entry.name} failed to mount: ${item.error}`);
      }
    }),
  );
}
