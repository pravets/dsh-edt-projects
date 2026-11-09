// Тесты определения репозитория и worktree по файлам (без git).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commonDirOf,
  gitFileAt,
  isSamePath,
  mainRootOf,
  repositoryAt,
  repositoriesUnder,
  uniqueRepositories,
} from '../packages/dsh-edt-projects/lib/repo.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'repo-test-'));
const real = (value) => realpathSync.native(value);

/** Обычный checkout: `.git` — каталог. */
function makeCheckout(root) {
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

/** Linked worktree: `.git` — файл, `commondir` в git-каталоге worktree. */
function makeWorktree(root, mainRoot, name = 'task') {
  const gitDir = join(mainRoot, '.git', 'worktrees', name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'commondir'), '../..\n', 'utf8');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.git'), `gitdir: ${gitDir.replace(/\\/g, '/')}\n`, 'utf8');
  return root;
}

test('gitFileAt читает gitdir и понимает обратные слэши', () => {
  const dir = tempDir();
  try {
    const main = makeCheckout(join(dir, 'main'));
    const worktree = makeWorktree(join(dir, 'wt'), main);
    assert.equal(real(gitFileAt(worktree)), real(join(main, '.git', 'worktrees', 'task')));
    assert.equal(gitFileAt(makeCheckout(join(dir, 'plain'))), undefined, 'каталог .git — не файл');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commonDirOf/mainRootOf разрешают commondir и основной checkout', () => {
  const dir = tempDir();
  try {
    const main = makeCheckout(join(dir, 'main'));
    const gitDir = join(main, '.git', 'worktrees', 'x');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'commondir'), '../..\n', 'utf8');
    assert.equal(real(commonDirOf(gitDir)), real(join(main, '.git')));
    assert.equal(real(mainRootOf(join(main, '.git'))), real(main));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repositoryAt: обычный checkout не worktree', () => {
  const dir = tempDir();
  try {
    const main = makeCheckout(join(dir, 'main'));
    const repo = repositoryAt(main);
    assert.equal(real(repo.root), real(main));
    assert.equal(real(repo.mainRoot), real(main));
    assert.equal(repo.isWorktree, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repositoryAt: linked worktree находит основной checkout и ищет вверх', () => {
  const dir = tempDir();
  try {
    const main = makeCheckout(join(dir, 'main'));
    const worktree = makeWorktree(join(dir, 'wt'), main);
    const repo = repositoryAt(join(worktree, 'src', 'cf'));
    assert.equal(real(repo.root), real(worktree));
    assert.equal(real(repo.mainRoot), real(main));
    assert.equal(repo.isWorktree, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repositoryAt: нет репозитория — undefined', () => {
  const dir = tempDir();
  try {
    assert.equal(repositoryAt(dir), undefined);
    assert.equal(repositoryAt(''), undefined);
    assert.equal(repositoryAt(undefined), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repositoryAt: submodule (нет commondir, .git/modules) — не worktree', () => {
  const dir = tempDir();
  try {
    const superRepo = makeCheckout(join(dir, 'super'));
    const sub = join(dir, 'super', 'vendor', 'lib');
    const gitDir = join(superRepo, '.git', 'modules', 'vendor', 'lib');
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), `gitdir: ${gitDir.replace(/\\/g, '/')}\n`, 'utf8');
    const repo = repositoryAt(sub);
    assert.equal(repo.isWorktree, false);
    assert.equal(real(repo.mainRoot), real(sub));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repositoriesUnder: task space — репозитории первого уровня, сортировка', () => {
  const dir = tempDir();
  try {
    const mainA = makeCheckout(join(dir, 'main-a'));
    const mainB = makeCheckout(join(dir, 'main-b'));
    const task = join(dir, 'task');
    makeWorktree(join(task, 'trade'), mainA);
    makeWorktree(join(task, 'unf'), mainB);
    mkdirSync(join(task, 'build'), { recursive: true });
    mkdirSync(join(task, '.worktree-space'), { recursive: true });
    mkdirSync(join(task, 'docs'), { recursive: true });

    const repos = repositoriesUnder(task);
    assert.deepEqual(repos.map((repo) => repo.root.split(/[\\/]/).pop()), ['trade', 'unf']);
    assert.ok(repos.every((repo) => repo.isWorktree === true));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repositoriesUnder: каталог сессии сам репозиторий — он и возвращается', () => {
  const dir = tempDir();
  try {
    const main = makeCheckout(join(dir, 'main'));
    const worktree = makeWorktree(join(dir, 'wt'), main);
    const repos = repositoriesUnder(worktree);
    assert.equal(repos.length, 1);
    assert.equal(real(repos[0].root), real(worktree));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repositoriesUnder: пустой каталог и несуществующий путь', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(repositoriesUnder(dir), []);
    assert.deepEqual(repositoriesUnder(join(dir, 'nope')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uniqueRepositories схлопывает дубликаты по нормализованному корню', () => {
  const dir = tempDir();
  try {
    const main = makeCheckout(join(dir, 'main'));
    const worktree = makeWorktree(join(dir, 'wt'), main);
    const repo = repositoryAt(worktree);
    assert.equal(uniqueRepositories([repo, repo, { ...repo, root: worktree.toUpperCase() }]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSamePath на Windows не зависит от регистра', () => {
  const options = { platform: 'win32', home: 'C:\\Users\\dev' };
  assert.equal(isSamePath('C:\\git\\trade', 'c:\\GIT\\Trade', options), true);
  assert.equal(isSamePath('C:\\git\\trade', 'C:\\git\\other', options), false);
});
