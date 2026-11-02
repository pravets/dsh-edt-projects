// Smoke-тест бандла: одноразовый профиль DSH, установка бандла из tarball,
// проверка композиции и живой MCP-сессии с заглушкой на порту из патча.
//
// Запуск:
//   node tools/smoke-bundle.mjs
// Переменные:
//   DSH_BIN   путь к @deepseek-ai/dsh/lib/bin.js (иначе ищется в node_modules)
//   SMOKE_KEEP=1  не удалять временный DSH_HOME (для разбора)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { startStubServer } from './stub-mcp-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const patchFile = join(root, 'edt-mcp', 'cordis.patch.yml');
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

// Конфигурация строки плагина берётся из самого патча: тест проверяет то,
// что реально уезжает в профиль, а не отдельную копию настроек.
function readPatchRow() {
  const rows = parseYaml(readFileSync(patchFile, 'utf8'));
  for (const row of rows ?? []) {
    for (const item of row?.insert ?? []) {
      if (String(item?.name ?? '').includes('mcp-client')) return item;
    }
  }
  throw new Error('в cordis.patch.yml нет строки dsh-mcp-client');
}

// В CI порт из патча свободен. Если он занят (например, настоящим MCP-сервером
// EDT на рабочей машине), SMOKE_PORT переносит установленную копию на другой порт.
function rewriteInstalledUrl(home, from, to) {
  const manifest = JSON.parse(readFileSync(join(root, 'edt-mcp', 'package.json'), 'utf8'));
  const installed = join(home, 'profiles', 'headless', 'node_modules', ...manifest.name.split('/'), 'cordis.patch.yml');
  if (!existsSync(installed)) throw new Error(`в профиле нет установленного патча: ${installed}`);
  const text = readFileSync(installed, 'utf8');
  if (!text.includes(from)) throw new Error(`в установленном патче нет ${from}`);
  const written = text.replaceAll(from, to);
  writeFileSync(installed, written);
  console.log(`  порт из патча занят, установленная копия переведена на ${to}`);
  return to;
}

function findTarball() {
  const dist = join(root, 'dist');
  if (!existsSync(dist)) throw new Error('нет dist/ — сначала соберите tarball (npm pack --workspace edt-mcp --pack-destination dist)');
  const tgz = readdirSync(dist).filter((f) => f.endsWith('.tgz'));
  if (tgz.length !== 1) throw new Error(`в dist/ ожидался один .tgz, найдено: ${tgz.length}`);
  return join(dist, tgz[0]);
}

async function main() {
  const bin = dshBin();
  if (!bin) throw new Error('не найден @deepseek-ai/dsh: задайте DSH_BIN или установите пакет');

  const row = readPatchRow();
  const tarball = findTarball();
  console.log(`патч: сервер ${row.config.serverName}, ${row.config.transport}, ${row.config.url}`);
  console.log(`tarball: ${tarball}`);

  const home = join(root, '.smoke', 'run');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const env = { DSH_HOME: home };

  // 1. Профиль headless создаётся самим CLI из шаблона.
  console.log('\n[1/4] создаю профиль headless');
  run(['headless', '--help'], { env, label: 'dsh headless --help' });

  // 2. Установка бандла из tarball — ровно тем же путём, что и у пользователя.
  console.log('[2/4] устанавливаю бандл из tarball');
  run(['plugin', '--profile', 'headless', 'add', tarball], { env, label: 'dsh plugin add' });

  let activeUrl = row.config.url;
  if (process.env.SMOKE_PORT) {
    const moved = new URL(activeUrl);
    moved.port = process.env.SMOKE_PORT;
    activeUrl = rewriteInstalledUrl(home, activeUrl, moved.href.replace(/\/$/, ''));
  }
  const url = new URL(activeUrl);

  // 3. Композиция профиля: строка плагина должна попасть в дерево с нашими настройками.
  console.log('[3/4] проверяю композицию профиля');
  const dump = run(['--profile', 'headless', '--dump-config'], { env, label: 'dsh --dump-config' });
  const composed = `${dump.stdout}${dump.stderr}`;
  if (!/edt[-_]mcp/.test(composed)) fail('в композиции профиля нет строки edt-mcp');
  if (!composed.includes(row.config.serverName)) fail(`в композиции нет serverName ${row.config.serverName}`);
  if (!composed.includes(activeUrl)) fail(`в композиции нет url ${activeUrl}`);
  if (!process.exitCode) console.log('  ok   строка плагина и её настройки в композиции');

  // 4. Живая сессия: заглушка на порту из патча должна получить initialize и tools/list.
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
