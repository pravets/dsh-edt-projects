// Тесты вики: нормализация путей, автопоиск входной точки и запрет записи.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { findEntry, isInside, normalizeWiki, targetPathOf, writeDenialReason } from '../packages/dsh-edt-projects/lib/wiki.mjs';

const base = join(process.cwd(), '.smoke');
mkdirSync(base, { recursive: true });

function makeWiki({ withIndex = 'wiki/index.md', withRootIndex = false, withReadme = false } = {}) {
  const dir = mkdtempSync(join(base, 'wiki-test-'));
  if (withIndex !== null) {
    mkdirSync(join(dir, 'wiki'), { recursive: true });
    writeFileSync(join(dir, withIndex), '# index\n');
  }
  if (withRootIndex) writeFileSync(join(dir, 'index.md'), '# root index\n');
  if (withReadme) writeFileSync(join(dir, 'README.md'), '# readme\n');
  return dir;
}

test('normalizeWiki: строка, массив и объект', () => {
  const first = makeWiki();
  const second = makeWiki({ withIndex: null, withReadme: true });

  assert.equal(normalizeWiki(first).roots.length, 1);
  assert.equal(normalizeWiki([first, second]).roots.length, 2);
  assert.equal(normalizeWiki({ paths: [first] }).roots[0].path, first);
});

test('normalizeWiki: несуществующие каталоги отбрасываются и перечисляются', () => {
  const real = makeWiki();
  const { roots, missing } = normalizeWiki([real, join(real, 'no-such-dir')]);
  assert.deepEqual(roots.map((root) => root.path), [real]);
  assert.equal(missing.length, 1);
});

test('normalizeWiki: пустая настройка даёт пустой список', () => {
  assert.deepEqual(normalizeWiki(undefined).roots, []);
  assert.deepEqual(normalizeWiki([]).roots, []);
  assert.deepEqual(normalizeWiki('').roots, []);
});

test('findEntry: wiki/index.md важнее index.md и README.md', () => {
  const dir = makeWiki({ withRootIndex: true, withReadme: true });
  assert.equal(findEntry(dir), join(dir, 'wiki', 'index.md'));

  const onlyRoot = makeWiki({ withIndex: null, withRootIndex: true, withReadme: true });
  assert.equal(findEntry(onlyRoot), join(onlyRoot, 'index.md'));

  const onlyReadme = makeWiki({ withIndex: null, withReadme: true });
  assert.equal(findEntry(onlyReadme), join(onlyReadme, 'README.md'));
});

test('findEntry: подсказка из настроек главнее стандартных имён', () => {
  const dir = makeWiki();
  writeFileSync(join(dir, 'AGENTS.md'), '# schema\n');
  assert.equal(findEntry(dir, 'AGENTS.md'), join(dir, 'AGENTS.md'));
});

test('isInside: вложенность и выход через ..', () => {
  const root = join(process.cwd(), '.smoke', 'w');
  assert.equal(isInside(join(root, 'a', 'b.md'), root), true);
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(join(root, '..', 'outside.md'), root), false);
  assert.equal(isInside(join(process.cwd(), '.smoke', 'other.md'), root), false);
});

test('writeDenialReason: запись в вики запрещена, чтение и чужие пути — нет', () => {
  const wiki = makeWiki();
  const roots = [{ path: wiki }];

  assert.match(writeDenialReason('write', join(wiki, 'wiki', 'page.md'), roots), /только для чтения/);
  assert.match(writeDenialReason('edit', join(wiki, 'note.md'), roots), /только для чтения/);

  assert.equal(writeDenialReason('read', join(wiki, 'wiki', 'index.md'), roots), undefined);
  assert.equal(writeDenialReason('write', join(process.cwd(), 'README.md'), roots), undefined);
  assert.equal(writeDenialReason('write', undefined, roots), undefined);
});

test('writeDenialReason: относительный путь разрешается от cwd', () => {
  const wiki = makeWiki();
  const roots = [{ path: wiki }];
  const cwd = wiki;
  assert.match(writeDenialReason('write', join('wiki', 'page.md'), roots, { cwd }), /только для чтения/);
});

test('targetPathOf: берёт путь из аргументов инструмента', () => {
  assert.equal(targetPathOf({ arguments: { file_path: 'a.bsl' } }), 'a.bsl');
  assert.equal(targetPathOf({ arguments: { path: 'b.bsl' } }), 'b.bsl');
  assert.equal(targetPathOf({ arguments: {} }), undefined);
  assert.equal(targetPathOf({}), undefined);
});
