// Smoke-тест бандла: одноразовый профиль DSH, установка бандла из tarball,
// проверка композиции и живой MCP-сессии с заглушкой.
//
// Запуск:
//   node tools/smoke-bundle.mjs
// Переменные:
//   DSH_BIN       путь к @deepseek-ai/dsh/lib/bin.js (иначе ищется в node_modules)
//   SMOKE_PORT    занять другой порт вместо порта из патча (локально, если он занят)
//   EDT_MCP_URL   адрес заглушки; по умолчанию берётся из патча
//   SMOKE_KEEP=1  не удалять временный DSH_HOME (для разбора)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { startStubServer } from './stub-mcp-server.mjs';

// `yaml` подключается как CommonJS, поэтому берём его default-экспорт.
const { parse: parseYaml } = YAML;

// `!!js 'выражение'` до разбора заменяется на объект {js: "..."}: публичного
// конструктора кастомного тега в yaml 2.9 нет.
const JS_TAG = /!!js\s+'((?:[^'\\]|\\.)*)'/g;
const parsePatch = (text) => parseYaml(text.replace(JS_TAG, (_, expr) => JSON.stringify({ js: expr })));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const patchFile = join(root, 'plugin', 'cordis.patch.yml');
const require = createRequire(import.meta.url);

const fail = (message) => {
  console.error(`\nSMOKE FAIL: ${message}`);
  process.exitCode = 1;
};

function dshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  const guesses = [];
  try {
    guesses.push(join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js'));
  } catch {
    // Экспорт package.json может быть закрыт — тогда смотрим в node_modules напрямую.
  }
  guesses.push(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  return guesses.find((path) => existsSync(path)) ?? null;
}

function run(args, { env, allowFailure = false, label } = {}) {
  const res = spawnSync(process.execPath, [dshBin(), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  if (res.status !== 0 && !allowFailure) {
    console.error(res.stdout ?? '');
    console.error(res.stderr ?? '');
    const reason = res.error ? `ошибка запуска: ${res.error.code ?? res.error.message}` : `код ${res.status}${res.signal ? `, сигнал ${res.signal}` : ''}`;
    throw new Error(`${label ?? args.join(' ')} — ${reason}`);
  }
  return res;
}

// Строка самого бандла берётся из патча: тест проверяет то, что реально
// уезжает в профиль, а не отдельную копию настроек.
function readHubRow() {
  const rows = parsePatch(readFileSync(patchFile, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'plugin', 'package.json'), 'utf8'));
  for (const row of rows ?? []) {
    for (const item of row?.insert ?? []) {
      if (item?.name === manifest.name) return item;
    }
  }
  throw new Error(`в cordis.patch.yml нет строки бандла ${manifest.name}`);
}

function findTarball() {
  const dist = join(root, 'dist');
  if (!existsSync(dist)) throw new Error('нет dist/ — сначала соберите tarball (npm pack --workspace plugin --pack-destination dist)');
  const { version } = JSON.parse(readFileSync(join(root, 'plugin', 'package.json'), 'utf8'));
  const tgz = readdirSync(dist).filter((f) => f.endsWith(`-${version}.tgz`));
  if (tgz.length !== 1) {
    const seen = readdirSync(dist).filter((f) => f.endsWith('.tgz')).join(', ') || 'ничего';
    throw new Error(`в dist/ ожидался один tarball версии ${version}, найдено: ${seen}`);
  }
  return join(dist, tgz[0]);
}

async function main() {
  const bin = dshBin();
  if (!bin) throw new Error('не найден @deepseek-ai/dsh: задайте DSH_BIN или установите пакет');

  const hub = readHubRow();
  const tarball = findTarball();

  // В CI порт из патча свободен, поэтому тестируется штатный путь без переопределений.
  // Локально рядом может работать настоящий сервер EDT — тогда SMOKE_PORT/EDT_MCP_URL.
  const port = process.env.SMOKE_PORT ?? '8765';
  const override = process.env.EDT_MCP_URL ?? (process.env.SMOKE_PORT ? `http://127.0.0.1:${port}/mcp` : null);
  const targetUrl = override ?? `http://127.0.0.1:${port}/mcp`;
  const url = new URL(targetUrl);

  const servers = Object.keys(hub.config?.servers ?? {});
  console.log(`tarball: ${tarball}`);
  console.log(`серверы хаба: ${servers.join(', ')}; ожидаемый адрес EDT ${targetUrl}${override ? ' (переопределён)' : ''}`);

  const home = join(root, '.smoke', 'run');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const env = { DSH_HOME: home, ...(override ? { EDT_MCP_URL: override } : {}) };

  // 1. Профиль headless создаётся самим CLI из шаблона.
  console.log('\n[1/4] создаю профиль headless');
  run(['headless', '--help'], { env, label: 'dsh headless --help' });

  // 2. Установка бандла из tarball — ровно тем же путём, что и у пользователя.
  console.log('[2/4] устанавливаю бандл из tarball');
  run(['plugin', '--profile', 'headless', 'add', tarball], { env, label: 'dsh plugin add' });

  // 3. Композиция профиля: строка плагина правил и строка сервера должны быть в дереве.
  console.log('[3/4] проверяю композицию профиля');
  const dump = run(['--profile', 'headless', '--dump-config'], { env, label: 'dsh --dump-config' });
  const composed = `${dump.stdout}${dump.stderr}`;
  if (!/edt[-_]mcp/.test(composed)) fail('в композиции профиля нет строки бандла');
  if (!composed.includes('mcp-hub')) fail('в композиции нет плагина mcp-hub');
  if (!hub.config?.servers?.edt) fail('в конфиге хаба нет сервера edt');
  if (!composed.includes('edt')) fail('в композиции нет сервера edt');
  // Значение url приходит из !!js-выражения: загрузчик может напечатать как
  // вычисленный адрес, так и само выражение — принимаем оба варианта.
  if (!composed.includes(targetUrl) && !composed.includes('process.env.EDT_MCP_URL')) {
    fail(`в композиции нет ни ${targetUrl}, ни выражения EDT_MCP_URL`);
  }
  if (!process.exitCode) console.log('  ok   правила и строка сервера попали в композицию');

  // 4. Живая сессия: заглушка должна получить initialize и tools/list.
  console.log(`[4/4] поднимаю заглушку на ${url.port} и стартую DSH`);
  const stub = await startStubServer({ port: Number(url.port), host: url.hostname });

  const boot = spawn(process.execPath, [bin, '--profile', 'headless', 'ping'], {
    cwd: root,
    env: { ...process.env, ...env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'smoke-dummy-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  boot.stdout.on('data', (c) => (output += c));
  boot.stderr.on('data', (c) => (output += c));

  try {
    await stub.waitFor('initialize', 60000);
    console.log('  ok   MCP-клиент подключился к заглушке (initialize)');
    await stub.waitFor('tools/list', 60000);
    console.log('  ok   инструменты запрошены (tools/list)');
  } catch (err) {
    fail(`${err.message}\n--- вывод DSH ---\n${output.slice(-3000)}`);
  } finally {
    boot.kill('SIGKILL');
    await stub.close();
  }

  if (!process.env.SMOKE_KEEP) rmSync(home, { recursive: true, force: true });

  if (process.exitCode) {
    console.error('\nSMOKE: провал');
  } else {
    console.log('\nSMOKE: ok');
  }
}

await main().catch((err) => {
  console.error(`\nSMOKE FAIL: ${err.message}`);
  process.exit(1);
});
