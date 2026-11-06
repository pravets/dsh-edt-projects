// Тесты загрузчика BSL Language Server: настройки, выбор ассета, кэш,
// скачивание с проверкой sha256 и сборка параметров монтирования.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bslAvailable, bslSettings, ensureJar, predictAsset, RateLimitError, resolveBsl, resolveReleaseViaHtml, selectExecAsset, startBslSupervisor } from '../edt-mcp/lib/bsl.mjs';

// Временные каталоги держим внутри рабочего каталога: системный TMP в
// ограниченном режиме может быть недоступен, а .smoke/ уже в .gitignore.
const base = join(process.cwd(), '.smoke');
mkdirSync(base, { recursive: true });
const tempDir = () => mkdtempSync(join(base, 'bsl-test-'));
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const release = (tag, body) => ({
  tag_name: tag,
  assets: [
    { name: `bsl-language-server-${tag}-javadoc.jar`, browser_download_url: `https://example/${tag}/javadoc.jar`, digest: 'sha256:aaaa' },
    { name: `bsl-language-server-${tag}-exec.jar`, browser_download_url: `https://example/${tag}/exec.jar`, size: body.length, digest: `sha256:${sha256(body)}` },
  ],
});

// Ответ как у fetch: JSON-релиз или поток с телом файла.
function fakeFetch({ rel, body }) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (String(url).includes('api.github.com')) return { ok: true, status: 200, json: async () => rel };
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(body));
          controller.close();
        },
      }),
    };
  };
  impl.calls = calls;
  return impl;
}

test('настройки: приоритет новых имён и разбор флага DOWNLOAD', () => {
  const settings = bslSettings({ DSH_1C_BSL_LS_JAR: '/a.jar', BSL_LS_JAR: '/old.jar', DSH_HOME: '/dsh', DSH_1C_BSL_LS_DOWNLOAD: '0' });
  assert.equal(settings.jar, '/a.jar');
  assert.equal(settings.downloadAllowed, false);
  assert.equal(settings.cacheDir, join('/dsh', 'cache', 'bsl-language-server'));

  const legacy = bslSettings({ BSL_LS_JAR: '/old.jar' });
  assert.equal(legacy.jar, '/old.jar');
  assert.equal(legacy.downloadAllowed, true);
});

test('selectExecAsset берёт fat-jar и его sha256', () => {
  const body = Buffer.from('jar');
  const asset = selectExecAsset(release('v1.0.7', body));
  assert.equal(asset.name, 'bsl-language-server-v1.0.7-exec.jar');
  assert.equal(asset.sha256, sha256(body));

  assert.throws(() => selectExecAsset({ tag_name: 'v0', assets: [{ name: 'x.jar' }] }), /exec\.jar/);
});

test('явный jar: существует — используется, нет — понятная ошибка', async () => {
  const dir = tempDir();
  const jar = join(dir, 'custom.jar');
  writeFileSync(jar, 'jar');
  assert.equal(await ensureJar({ jar, cacheDir: dir }), jar);
  await assert.rejects(ensureJar({ jar: join(dir, 'missing.jar'), cacheDir: dir }), /файла нет/);
});

test('готовый кэш используется без обращения к сети', async () => {
  const dir = tempDir();
  const cached = join(dir, 'bsl-language-server-1.0.7-exec.jar');
  writeFileSync(cached, 'jar');
  const exploding = async () => {
    throw new Error('сеть не должна вызываться');
  };
  const result = await ensureJar({ cacheDir: dir, downloadAllowed: true }, { fetchImpl: exploding });
  assert.equal(result, cached);
});

test('скачивание по версии: sha256 проверен, .part убран', async () => {
  const dir = tempDir();
  const body = Buffer.from('fake jar body');
  const fetchImpl = fakeFetch({ rel: release('v1.0.7', body), body });

  const jar = await ensureJar({ cacheDir: dir, version: 'v1.0.7', downloadAllowed: true }, { fetchImpl });
  assert.equal(jar, join(dir, 'bsl-language-server-v1.0.7-exec.jar'));
  assert.deepEqual(readFileSync(jar), body);
  assert.deepEqual(readdirSync(dir), ['bsl-language-server-v1.0.7-exec.jar']);
  assert.ok(fetchImpl.calls.some((url) => url.includes('/releases/tags/v1.0.7')));
});

test('несовпадение sha256 не оставляет файла', async () => {
  const dir = tempDir();
  const body = Buffer.from('fake jar body');
  const rel = release('v1.0.7', body);
  rel.assets[1].digest = `sha256:${'0'.repeat(64)}`;
  const fetchImpl = fakeFetch({ rel, body });

  await assert.rejects(ensureJar({ cacheDir: dir, version: 'v1.0.7', downloadAllowed: true }, { fetchImpl }), /sha256 не совпал/);
  assert.deepEqual(readdirSync(dir), []);
});

test('скачивание запрещено и кэша нет — понятный отказ', async () => {
  const dir = tempDir();
  await assert.rejects(
    ensureJar({ cacheDir: dir, downloadAllowed: false }, { fetchImpl: async () => assert.fail('сеть не нужна') }),
    /DSH_1C_BSL_LS_JAR/,
  );
});

test('resolveBsl: URL сервера даёт http, jar даёт stdio', async () => {
  assert.deepEqual(await resolveBsl({ mcpUrl: 'http://127.0.0.1:8080/mcp' }), { transport: 'streamable-http', url: 'http://127.0.0.1:8080/mcp' });

  const dir = tempDir();
  const jar = join(dir, 'a.jar');
  writeFileSync(jar, 'jar');
  const resolved = await resolveBsl({ jar, java: 'java', cwd: '/src', cacheDir: dir });
  assert.deepEqual(resolved, { transport: 'stdio', command: 'java', args: ['-jar', jar, 'mcp'], cwd: '/src' });
});

test('bslAvailable: без пути и без скачивания сервер не настроен', () => {
  assert.equal(bslAvailable({ downloadAllowed: true }), true);
  assert.equal(bslAvailable({ downloadAllowed: false }), false);
  assert.equal(bslAvailable({ downloadAllowed: false, jar: '/a.jar' }), true);
  assert.equal(bslAvailable({ downloadAllowed: false, mcpUrl: 'http://x/mcp' }), true);
});

test('startBslSupervisor: несуществующий корень — ошибка сразу, без ожидания порта', async () => {
  const dir = tempDir();
  const jar = join(dir, 'a.jar');
  writeFileSync(jar, 'jar');
  const started = Date.now();
  await assert.rejects(
    startBslSupervisor({ jar, root: join(dir, 'no-such-dir'), timeoutMs: 60_000 }),
    /каталог рабочего пространства не найден/,
  );
  assert.ok(Date.now() - started < 5000, 'должно падать без ожидания порта');
});

test('startBslSupervisor: отсутствующая java-команда — ошибка запуска, а не таймаут', async () => {
  const dir = tempDir();
  const jar = join(dir, 'a.jar');
  writeFileSync(jar, 'jar');
  await assert.rejects(
    startBslSupervisor({ jar, java: join(dir, 'no-such-java'), root: dir, timeoutMs: 60_000 }),
    /не запустился|не удалось запустить|завершился при запуске/,
  );
});

// --- источники релиза при лимите GitHub API ---------------------------------

const streamOf = (body) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(body));
      controller.close();
    },
  });

// Ответ в форме fetch: заголовки читаются через get(), тело — одноразовое.
const reply = ({ ok = true, status = 200, url, headers = {}, json, text, body } = {}) => ({
  ok,
  status,
  url,
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  json: json ?? (async () => assert.fail('JSON не ожидался')),
  text: text ?? (async () => ''),
  body,
});

/** Роутер запросов: первый совпавший шаблон (подстрока) отдаёт ответ. */
const routedFetch = (routes) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [pattern, handler] of routes) {
      if (String(url).includes(pattern)) return typeof handler === 'function' ? handler(String(url), init) : handler;
    }
    return reply({ ok: false, status: 404, json: async () => ({ message: 'Not Found' }) });
  };
  impl.calls = calls;
  return impl;
};

const latestPage = (tag) => reply({ url: `https://github.com/1c-syntax/bsl-language-server/releases/tag/${tag}` });

const assetsPage = (tag, digest) =>
  reply({
    text: async () => `
      <li><a href="/1c-syntax/bsl-language-server/releases/download/${tag}/bsl-language-server-${tag.replace(/^v/, '')}-exec.jar">exec</a>
      <span>sha256:${digest}</span></li>`,
  });

const jarDownload = (body) => reply({ body: streamOf(body), headers: { 'content-length': String(body.length) } });

const rateLimited = (resetIso) =>
  reply({
    ok: false,
    status: 403,
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(Date.parse(resetIso) / 1000)),
    },
    json: async () => ({ message: 'API rate limit exceeded for 203.0.113.1' }),
  });

test('токен: приоритет DSH_1C-имени, затем GITHUB_TOKEN и GH_TOKEN', () => {
  assert.equal(bslSettings({ DSH_1C_BSL_LS_GITHUB_TOKEN: 'own', GITHUB_TOKEN: 'gh', GH_TOKEN: 'cli' }).githubToken, 'own');
  assert.equal(bslSettings({ GITHUB_TOKEN: 'gh', GH_TOKEN: 'cli' }).githubToken, 'gh');
  assert.equal(bslSettings({ GH_TOKEN: 'cli' }).githubToken, 'cli');
  assert.equal(bslSettings({}).githubToken, undefined);
});

test('predictAsset: имя файла и адрес выводятся из тега', () => {
  const asset = predictAsset('v1.0.7');
  assert.equal(asset.name, 'bsl-language-server-1.0.7-exec.jar');
  assert.equal(asset.url, 'https://github.com/1c-syntax/bsl-language-server/releases/download/v1.0.7/bsl-language-server-1.0.7-exec.jar');
  assert.equal(asset.unverified, true);
});

test('resolveReleaseViaHtml берёт тег из редиректа и sha256 со страницы ассетов', async () => {
  const body = Buffer.from('html jar');
  const fetchImpl = routedFetch([
    ['/releases/latest', latestPage('v1.2.3')],
    ['/expanded_assets/v1.2.3', assetsPage('v1.2.3', sha256(body))],
  ]);
  const asset = await resolveReleaseViaHtml(fetchImpl);
  assert.equal(asset.tag, 'v1.2.3');
  assert.equal(asset.name, 'bsl-language-server-1.2.3-exec.jar');
  assert.equal(asset.sha256, sha256(body));
});

test('без токена успешная загрузка не обращается к api.github.com', async () => {
  const dir = tempDir();
  const body = Buffer.from('html jar body');
  const fetchImpl = routedFetch([
    ['/releases/latest', latestPage('v1.2.3')],
    ['/expanded_assets/v1.2.3', assetsPage('v1.2.3', sha256(body))],
    ['/download/v1.2.3/', jarDownload(body)],
  ]);

  const jar = await ensureJar({ cacheDir: dir, downloadAllowed: true }, { fetchImpl });
  assert.equal(jar, join(dir, 'bsl-language-server-1.2.3-exec.jar'));
  assert.deepEqual(readFileSync(jar), body);
  assert.ok(
    fetchImpl.calls.every((call) => !call.url.includes('api.github.com')),
    'API не должен участвовать: ' + fetchImpl.calls.map((call) => call.url).join(', '),
  );
});

test('с токеном первым идёт API, токен уходит только на api.github.com', async () => {
  const dir = tempDir();
  const body = Buffer.from('api jar body');
  const exec = release('v1.0.7', body).assets[1];
  const fetchImpl = routedFetch([
    ['api.github.com/repos/1c-syntax/bsl-language-server/releases/latest', reply({ json: async () => release('v1.0.7', body) })],
    ['example/v1.0.7/exec.jar', jarDownload(body)],
  ]);

  const jar = await ensureJar({ cacheDir: dir, downloadAllowed: true, githubToken: 'tkn' }, { fetchImpl });
  assert.equal(jar, join(dir, exec.name));
  assert.ok(fetchImpl.calls[0].url.includes('api.github.com'), 'API должен быть первым источником');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer tkn');
  const download = fetchImpl.calls.find((call) => call.url.includes('example/'));
  assert.equal(download.init.headers, undefined, 'на скачивание ассета токен не нужен');
});

test('лимит API при заданном токене не срывает загрузку: работает страница релиза', async () => {
  const dir = tempDir();
  const body = Buffer.from('fallback jar body');
  const warnings = [];
  const fetchImpl = routedFetch([
    ['api.github.com', rateLimited('2026-11-06T18:00:00Z')],
    ['/releases/latest', latestPage('v1.2.3')],
    ['/expanded_assets/v1.2.3', assetsPage('v1.2.3', sha256(body))],
    ['/download/v1.2.3/', jarDownload(body)],
  ]);

  const jar = await ensureJar({ cacheDir: dir, downloadAllowed: true, githubToken: 'tkn' }, { fetchImpl, warn: (m) => warnings.push(m) });
  assert.deepEqual(readFileSync(jar), body);
  assert.ok(warnings.some((line) => /лимит/.test(line)), 'причина отказа API должна попасть в предупреждение');
});

test('закреплённая версия без токена: берётся её страница, а не latest', async () => {
  const dir = tempDir();
  const body = Buffer.from('pinned jar body');
  const fetchImpl = routedFetch([
    ['/expanded_assets/v1.0.7', assetsPage('v1.0.7', sha256(body))],
    ['/download/v1.0.7/', jarDownload(body)],
  ]);

  const jar = await ensureJar({ cacheDir: dir, version: 'v1.0.7', downloadAllowed: true }, { fetchImpl });
  assert.equal(jar, join(dir, 'bsl-language-server-1.0.7-exec.jar'));
  assert.ok(!fetchImpl.calls.some((call) => call.url.includes('/releases/latest')));
});

test('неразобранная страница: предсказуемый адрес без sha256 и предупреждение', async () => {
  const dir = tempDir();
  const body = Buffer.from('unverified jar body');
  const warnings = [];
  const fetchImpl = routedFetch([
    ['/expanded_assets/v1.0.7', reply({ text: async () => '<p>ассетов нет</p>' })],
    ['api.github.com', rateLimited('2026-11-06T18:00:00Z')],
    ['/download/v1.0.7/bsl-language-server-1.0.7-exec.jar', jarDownload(body)],
  ]);

  const jar = await ensureJar({ cacheDir: dir, version: 'v1.0.7', downloadAllowed: true }, { fetchImpl, warn: (m) => warnings.push(m) });
  assert.equal(jar, join(dir, 'bsl-language-server-1.0.7-exec.jar'));
  assert.ok(warnings.some((line) => /не сверен/.test(line)), 'отсутствие sha256 не должно быть молчаливым');
});

test('все источники недоступны: ошибка называет лимит, время сброса и выходы', async () => {
  const dir = tempDir();
  const fetchImpl = routedFetch([
    ['api.github.com', rateLimited('2026-11-06T18:00:00Z')],
    ['/expanded_assets/', reply({ ok: false, status: 500 })],
    ['/download/', reply({ ok: false, status: 404 })],
  ]);

  const error = await ensureJar({ cacheDir: dir, version: 'v9.9.9', downloadAllowed: true, githubToken: 'tkn' }, { fetchImpl }).catch((e) => e);
  assert.ok(error instanceof RateLimitError);
  assert.match(error.message, /лимит/);
  assert.match(error.message, /2026-11-06T18:00:00\.000Z/);
  for (const hint of ['DSH_1C_BSL_LS_GITHUB_TOKEN', 'DSH_1C_BSL_LS_VERSION', 'DSH_1C_BSL_LS_URL', 'DSH_1C_BSL_LS_JAR']) {
    assert.ok(error.message.includes(hint), `в ошибке нет подсказки ${hint}`);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('все источники недоступны, но в кэше есть другая версия — берётся кэш', async () => {
  const dir = tempDir();
  const cached = join(dir, 'bsl-language-server-1.0.7-exec.jar');
  writeFileSync(cached, 'old jar');
  const warnings = [];
  const fetchImpl = routedFetch([
    ['api.github.com', rateLimited('2026-11-06T18:00:00Z')],
    ['/expanded_assets/', reply({ ok: false, status: 500 })],
    ['/download/', reply({ ok: false, status: 404 })],
  ]);

  const jar = await ensureJar({ cacheDir: dir, version: 'v9.9.9', downloadAllowed: true, githubToken: 'tkn' }, { fetchImpl, warn: (m) => warnings.push(m) });
  assert.equal(jar, cached);
  assert.ok(warnings.some((line) => /кэш/.test(line)), 'подмена версии должна быть видна');
});

test('несуществующий тег — обычная ошибка, а не «лимит»', async () => {
  const dir = tempDir();
  const fetchImpl = routedFetch([
    ['/expanded_assets/', reply({ ok: false, status: 404 })],
    ['api.github.com', reply({ ok: false, status: 404, json: async () => ({ message: 'Not Found' }) })],
    ['/download/', reply({ ok: false, status: 404 })],
  ]);

  const error = await ensureJar({ cacheDir: dir, version: 'v0.0.1', downloadAllowed: true }, { fetchImpl }).catch((e) => e);
  assert.match(error.message, /не удалось получить релиз/);
  assert.doesNotMatch(error.message, /лимит/);
});

test('bslAvailable: кэш считается источником и при запрете скачивания', () => {
  const dir = tempDir();
  assert.equal(bslAvailable({ downloadAllowed: false, cacheDir: dir }), false);
  writeFileSync(join(dir, 'bsl-language-server-1.0.7-exec.jar'), 'jar');
  assert.equal(bslAvailable({ downloadAllowed: false, cacheDir: dir }), true);
});
