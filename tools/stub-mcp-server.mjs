// Минимальный MCP-сервер для smoke-теста: Streamable HTTP, JSON-RPC без SSE.
// Умеет ровно то, что нужно проверить связку: initialize, tools/list, tools/call.
//
// Экспорт:
//   startStubServer({ port, host }) -> { url, port, calls, close() }
// где calls — массив имён вызванных методов (для проверок в тесте).
//
// Запуск вручную:
//   node tools/stub-mcp-server.mjs 8765
import { createServer } from 'node:http';

export const STUB_TOOL = 'ping';
export const STUB_ANSWER = 'pong';

const PROTOCOL = '2025-11-25';

function jsonRpc(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function startStubServer({ port = 0, host = '127.0.0.1' } = {}) {
  const calls = [];
  const listeners = [];

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'only POST /mcp is supported' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(null, -32700, 'parse error')));
        return;
      }

      const method = message.method ?? '';
      const id = message.id;

      // Уведомление (без id) — по спеке ответ не нужен.
      if (id === undefined || id === null) {
        calls.push(method);
        listeners.forEach((fn) => fn(method));
        res.writeHead(202).end();
        return;
      }

      calls.push(method);
      listeners.forEach((fn) => fn(method));

      let payload;
      switch (method) {
        case 'initialize':
          payload = jsonRpc(id, {
            protocolVersion: message.params?.protocolVersion ?? PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'dsh-edt-stub', version: '1.0.0' },
          });
          break;
        case 'tools/list':
          payload = jsonRpc(id, {
            tools: [
              {
                name: STUB_TOOL,
                description: 'Smoke-test tool: answers pong.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
            ],
          });
          break;
        case 'tools/call':
          payload = jsonRpc(id, {
            content: [{ type: 'text', text: STUB_ANSWER }],
            isError: false,
          });
          break;
        case 'ping':
          payload = jsonRpc(id, {});
          break;
        default:
          payload = jsonRpcError(id, -32601, `method not found: ${method}`);
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        url: `http://${host}:${actual}/mcp`,
        port: actual,
        calls,
        /** Ждёт, пока сервер получит указанный метод (или бросает по таймауту). */
        waitFor(method, timeoutMs = 15000) {
          if (calls.includes(method)) return Promise.resolve();
          return new Promise((done, fail) => {
            const timer = setTimeout(() => {
              const seen = [...new Set(calls)].join(', ') || 'ничего';
              fail(new Error(`заглушка не получила ${method} за ${timeoutMs} мс; получено: ${seen}`));
            }, timeoutMs);
            listeners.push((name) => {
              if (name !== method) return;
              clearTimeout(timer);
              done();
            });
          });
        },
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

// Прямой запуск: node tools/stub-mcp-server.mjs [port]
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const port = Number(process.argv[2] ?? 8765);
  const stub = await startStubServer({ port });
  console.log(`заглушка MCP слушает ${stub.url}`);
  const stop = async () => {
    await stub.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
