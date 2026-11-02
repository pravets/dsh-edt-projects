// Тесты загрузчика BSL Language Server: настройки, выбор ассета, кэш,
// скачивание с проверкой sha256 и сборка параметров монтирования.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bslAvailable, bslSettings, ensureJar, resolveBsl, selectExecAsset } from '../edt-mcp/lib/bsl.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-bsl-'));
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
