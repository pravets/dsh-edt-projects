// Проверка связки «DSH ↔ MCP-сервер 1C:EDT» без установки плагина:
// открывает настоящую MCP-сессию официальным SDK, печатает версию сервера,
// число инструментов и делает два безопасных вызова.
//
// Запуск:
//   node tools/check-edt-mcp.mjs [sdkDir] [url]
// Порт по умолчанию — 8765, как у EDT-MCP. Если рядом лежит plugin/cordis.patch.yml,
// url берётся из него, в том числе из !!js-выражения с запасным адресом.
// Переопределение: аргументы, затем переменные EDT_MCP_URL и DSH_MCP_SDK_DIR.
//
// SDK ищется так: обычный импорт из node_modules (npm install), затем sdkDir
// (аргумент или DSH_MCP_SDK_DIR).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = 'http://127.0.0.1:8765/mcp';

/**
 * Адрес сервера из патча бандла. Значение может быть как строкой, так и
 * !!js-выражением (`process.env.EDT_MCP_URL ?? "http://127.0.0.1:8765/mcp"`),
 * поэтому вытаскиваем первый http(s)-адрес из строки url.
 */
function urlFromPatch() {
  const patch = join(here, '..', 'plugin', 'cordis.patch.yml');
  if (!existsSync(patch)) return null;
  const line = /^\s*url:\s*(.+)$/m.exec(readFileSync(patch, 'utf8'))?.[1];
  return /(https?:\/\/[^"'\s]+)/.exec(line ?? '')?.[1] ?? null;
}

async function loadSdk() {
  try {
    return await import('@modelcontextprotocol/client');
  } catch {
    // Пакета в node_modules нет — падать пока рано, пробуем каталог из окружения.
  }
  const sdkDir = process.argv[2] ?? process.env.DSH_MCP_SDK_DIR;
  if (sdkDir === undefined || !existsSync(join(sdkDir, 'dist', 'index.mjs'))) {
    throw new Error(
      'MCP SDK не найден: выполните npm install в репозитории либо задайте DSH_MCP_SDK_DIR ' +
        '(каталог пакета @modelcontextprotocol/client с dist/index.mjs) или передайте его первым аргументом.',
    );
  }
  return import(pathToFileURL(join(sdkDir, 'dist', 'index.mjs')).href);
}

const url = process.argv[3] ?? process.env.EDT_MCP_URL ?? urlFromPatch() ?? DEFAULT_URL;

const target = new URL(url);
const host = target.hostname;
const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));

function probeTcp(hostname, portNum, timeoutMs = 3000) {
  return new Promise((resolve) => {
    import('node:net').then(({ connect }) => {
      const socket = connect({ host: hostname, port: portNum });
      const done = (ok, reason) => {
        socket.destroy();
        resolve({ ok, reason });
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false, 'timeout'));
      socket.once('error', (err) => done(false, err.code ?? String(err)));
    });
  });
}

async function main() {
  console.log(`Проверяю ${url}`);

  const tcp = await probeTcp(host, port);
  if (!tcp.ok) {
    console.log(`ПОРТ ${port}: ${tcp.reason}. MCP-сервер EDT не слушает этот порт.`);
    console.log('Включите сервер: EDT → Window → Preferences → MCP Server → порт и Start.');
    process.exit(2);
  }
  console.log(`ПОРТ ${port}: слушает`);

  // Кто отвечает: у MCP-сервера на GET /mcp обычно HTTP-ошибка в JSON,
  // у постороннего сервиса — HTML-страница.
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    const server = res.headers.get('server') ?? '';
    const body = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
    console.log(`GET /mcp → ${res.status} ${res.headers.get('content-type') ?? ''}${server ? ` server=${server}` : ''}`);
    if (/html/i.test(res.headers.get('content-type') ?? '') || /^<!doctype|<html/i.test(body)) {
      console.log(`ВНИМАНИЕ: на порту отвечает не MCP, а веб-страница: ${body}`);
    }
  } catch (err) {
    console.log(`GET /mcp → ${err.name}: ${err.message} (для MCP это нормально)`);
  }

  const { Client, StreamableHTTPClientTransport } = await loadSdk();
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'dsh-edt-check', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    const info = client.getServerVersion?.() ?? null;
    console.log(`MCP OK: server=${info?.name ?? '?'} ${info?.version ?? ''} protocol=${info?.protocolVersion ?? transport.protocolVersion ?? '?'}`);

    const { tools } = await client.listTools();
    console.log(`ИНСТРУМЕНТОВ: ${tools.length}`);
    console.log(`ИМЕНА: ${tools.slice(0, 12).map((t) => t.name).join(', ')}${tools.length > 12 ? ', …' : ''}`);

    for (const name of ['get_edt_version', 'list_projects']) {
      if (!tools.some((t) => t.name === name)) {
        console.log(`ВЫЗОВ ${name}: инструмент выключен в EDT (Tools tab) — пропускаю`);
        continue;
      }
      try {
        const res = await client.callTool({ name, arguments: {} });
        const text = (res.content ?? [])
          .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
          .join(' ')
          .replace(/\s+/g, ' ')
          .slice(0, 400);
        console.log(`ВЫЗОВ ${name}: ${res.isError ? 'ОШИБКА' : 'OK'} — ${text}`);
      } catch (err) {
        console.log(`ВЫЗОВ ${name}: ${err.message}`);
      }
    }
  } finally {
    await client.close().catch(() => {});
  }
}

await main().catch((err) => {
  console.error(`СБОЙ: ${err.message}`);
  process.exit(1);
});
