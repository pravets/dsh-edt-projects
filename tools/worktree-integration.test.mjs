// Интеграционный тест: сессия в worktree наследует включённость от основного
// checkout, и промпт получает блок про окружение EDT.
//
// Плагин применяется на поддельном контексте Cordis: проверяются именно
// активация, выбор каталогов настроек и текст правила, без запуска процессов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../packages/dsh-edt-projects/lib/index.js';

/** Минимальный контекст: инструменты, события, промпт и навыки. */
function fakeContext() {
  const sections = new Map();
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    logger: { warn() {}, info() {} },
    tools: {
      register: () => () => {},
      guard: () => {},
      schemas: () => [],
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    inject(names, callback) {
      if (names.includes('systemPrompt')) {
        callback({
          systemPrompt: {
            getSectionOrder: () => 100,
            section: (definition) => sections.set(definition.name, definition),
          },
        });
      }
      if (names.includes('skills')) {
        callback({ skills: { registerProvider: () => () => {} } });
      }
    },
  };
  return { ctx, sections, handlers, disposers };
}

function fixture({ enabledFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-integration-'));
  const main = join(dir, 'main');
  const worktree = join(dir, 'worktree-space', 'trade', 'task', 'trade');
  const gitDir = join(main, '.git', 'worktrees', 'task');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'commondir'), '../..\n', 'utf8');
  mkdirSync(join(worktree, 'src', 'cf'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'cf', '.project'), '', 'utf8');
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir.replace(/\\/g, '/')}\n`, 'utf8');
  if (enabledFile !== undefined) writeFileSync(join(main, '.dsh-1c.json'), JSON.stringify(enabledFile), 'utf8');
  return { dir, main, worktree };
}

const agentIn = (cwd) => ({ session: { header: { cwd } } });

test('worktree: промпт включает правила 1С и блок окружения из настроек main', async () => {
  const { dir, main, worktree } = fixture({
    enabledFile: { enabled: true, workspace: { import: 'auto' }, servers: { edt: { url: 'http://127.0.0.1:8765/mcp' } } },
  });
  try {
    const { ctx, sections } = fakeContext();
    await apply(ctx, { servers: { edt: { url: 'http://127.0.0.1:8765/mcp' } } });
    const section = sections.get('mcp-rules:1c');
    assert.ok(section, 'секция промпта зарегистрирована');

    const text = section.text({ agent: agentIn(worktree) });
    assert.match(text, /Работа с 1С через MCP/);
    assert.match(text, /### Окружение EDT в worktree/);
    assert.match(text, /build[\\/]ws/);
    assert.match(text, /edt_workspace/);

    // Основной checkout имя проекта наследует, но окружение там не поднимается.
    const mainText = section.text({ agent: agentIn(main) });
    assert.match(mainText, /Работа с 1С через MCP/);
    assert.doesNotMatch(mainText, /### Окружение EDT в worktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktree: enabled:false в main выключает сессию worktree', async () => {
  const { dir, worktree } = fixture({ enabledFile: { enabled: false } });
  try {
    const { ctx, sections } = fakeContext();
    await apply(ctx, {});
    const section = sections.get('mcp-rules:1c');
    assert.equal(section.text({ agent: agentIn(worktree) }), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktree: без настроек в main и без projects сессия выключена', async () => {
  const { dir, worktree } = fixture();
  try {
    const { ctx, sections } = fakeContext();
    await apply(ctx, {});
    const section = sections.get('mcp-rules:1c');
    assert.equal(section.text({ agent: agentIn(worktree) }), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktree: projects в пользовательском файле включает и наследуется', async () => {
  const { dir, main, worktree } = fixture();
  try {
    mkdirSync(join(dir, 'home'), { recursive: true });
    writeFileSync(join(dir, 'home', 'dsh-1c.json'), JSON.stringify({ projects: [main] }), 'utf8');
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = join(dir, 'home');
    try {
      const { ctx, sections } = fakeContext();
      await apply(ctx, {});
      const text = sections.get('mcp-rules:1c').text({ agent: agentIn(worktree) });
      assert.match(text, /Работа с 1С через MCP/);
      assert.match(text, /### Окружение EDT в worktree/);
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
