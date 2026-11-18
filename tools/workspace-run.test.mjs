// Тесты фонового подъёма и остановки EDT-окружения worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeWorkspaceSettings,
  prepareWorkspaceSnapshot,
  readPid,
  readPort,
  readProgress,
  stateOf,
  writeImported,
  writePid,
  writePort,
  writeStamp,
  writeWorkspaceSnapshot,
  prefsPath,
} from '../packages/dsh-edt-projects/lib/workspace.mjs';
import {
  cmdInit,
  cmdRun,
  cmdStop,
  cmdStopAll,
  defaultSnapshot,
  parseArgs,
  shouldImport,
  runLockActive,
  statusReport,
  waitHealth,
  waitReady,
} from '../packages/dsh-edt-projects/lib/workspace-run.mjs';

const tempRoot = () => mkdtempSync(join(tmpdir(), 'ws-run-'));
const projectDir = (root, rel) => {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.project'), '', 'utf8');
  return dir;
};

function snapshotFor(root, overrides = {}) {
  const settings = normalizeWorkspaceSettings({ import: false, ...overrides });
  return prepareWorkspaceSnapshot({ root, mainRoot: join(root, '..', 'main'), settings });
}

const fakeEdt = (root) => ({
  home: root,
  bin: join(root, 'fake-1cedt'),
  cli: join(root, 'fake-1cedtcli'),
  mcpBundle: true,
});

test('parseArgs: действие, флаги и значения', () => {
  assert.deepEqual(parseArgs([]), { action: 'init', root: undefined, repo: undefined, json: false, import: undefined });
  assert.deepEqual(parseArgs(['status', '--root', 'C:/wt', '--json']), {
    action: 'status',
    root: 'C:/wt',
    repo: undefined,
    json: true,
    import: undefined,
  });
  assert.deepEqual(parseArgs(['stop-all', '--repo', 'C:/repo']).repo, 'C:/repo');
  assert.equal(parseArgs(['run', '--import']).import, true);
  assert.equal(parseArgs(['run']).import, undefined);
});

test('defaultSnapshot: настройки по умолчанию, каталог из файлов и найденные проекты', () => {
  const root = tempRoot();
  try {
    const cf = projectDir(root, 'src/cf');
    const snapshot = defaultSnapshot(root, {});
    assert.equal(snapshot.buildDir, join(root, 'build'));
    assert.equal(snapshot.wsDir, join(root, 'build', 'ws'), 'без снимка и старого каталога — старое место');
    assert.deepEqual(snapshot.projects, [cf]);
    assert.equal(snapshot.settings.import, 'auto');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdInit занимает порт, пишет prefs и запускает run в фоне', async () => {
  const root = tempRoot();
  try {
    const snapshot = snapshotFor(root);
    const spawns = [];
    const code = await cmdInit(root, {}, {
      snapshot,
      pickFreePort: async () => 23456,
      isPortFree: async () => true,
      spawnDetached: (command, args, log, cwd) => {
        spawns.push({ command, args, log, cwd });
        return { pid: 111 };
      },
    });
    assert.equal(code, 0);
    assert.equal(readPort(join(root, 'build')), 23456);
    assert.match(readFileSync(prefsPath(join(root, 'build', 'ws')), 'utf8'), /mcpServerPort=23456/);
    const prefs = readFileSync(prefsPath(join(root, 'build', 'ws')), 'utf8');
    assert.match(prefs, /mcpServerHttpEnabled=true/);
    assert.match(prefs, /mcpPlainTextMode=true/, 'plain text включается до запуска EDT');
    assert.match(prefs, /mcpDisabledTools=git,ask_workmate/, 'get_form_screenshot включён до запуска EDT');
    assert.equal(existsSync(join(root, 'build', 'workspace.json')), true);
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0].args.slice(1), ['run', '--root', root]);
    assert.equal(spawns[0].cwd, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdInit сам занимает свободный порт, если pickFreePort не передан', async () => {
  const root = tempRoot();
  try {
    const snapshot = snapshotFor(root);
    const code = await cmdInit(root, {}, {
      snapshot,
      isPortFree: async () => true,
      spawnDetached: () => ({ pid: 1 }),
    });
    assert.equal(code, 0);
    const port = readPort(join(root, 'build'));
    assert.ok(port >= 20000 && port <= 39999, `порт ${port} вне диапазона`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdInit переиспользует свободный порт и не поднимает готовое окружение', async () => {
  const root = tempRoot();
  try {
    const snapshot = snapshotFor(root);
    writePort(join(root, 'build'), 23456);
    let spawns = 0;
    const code = await cmdInit(root, {}, {
      snapshot,
      pickFreePort: async () => 23457,
      isPortFree: async () => true,
      spawnDetached: () => {
        spawns++;
        return { pid: 1 };
      },
    });
    assert.equal(code, 0);
    assert.equal(readPort(join(root, 'build')), 23456);
    assert.equal(spawns, 1);

    // Готовое окружение: pid жив, маркер ready — повторный init ничего не делает.
    writePid(join(root, 'build'), 4242);
    writeStamp(join(root, 'build'), 'ready');
    const ready = await cmdInit(root, {}, {
      snapshot,
      alive: () => true,
      pickFreePort: async () => 23457,
      isPortFree: async () => true,
      spawnDetached: () => {
        spawns++;
        return { pid: 1 };
      },
    });
    assert.equal(ready, 0);
    assert.equal(spawns, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdRun без импорта запускает EDT и дожидается готовности', async () => {
  const root = tempRoot();
  try {
    const snapshot = snapshotFor(root);
    const buildDir = join(root, 'build');
    writePort(buildDir, 23456);
    writeWorkspaceSnapshot(buildDir, snapshot);
    const spawned = [];
    const code = await cmdRun(root, {}, {
      snapshot,
      detectEdtHome: () => fakeEdt(root),
      resolveEdtVm: () => undefined,
      runCapture: async () => {
        throw new Error('без импорта 1cedtcli не должен запускаться');
      },
      spawnDetached: (command, args, log, cwd) => {
        spawned.push({ command, args, cwd });
        return { pid: 4242 };
      },
      waitReady: async () => ({ ok: true }),
    });
    assert.equal(code, 0);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, join(root, 'fake-1cedt'));
    assert.deepEqual(spawned[0].args.slice(0, 3), ['-nosplash', '-data', join(buildDir, 'ws')]);
    assert.ok(spawned[0].args.includes('-DnativeFormBufferedLayoutRender=true'), 'флаг скриншотов форм');
    const prefs = readFileSync(prefsPath(join(buildDir, 'ws')), 'utf8');
    assert.match(prefs, /mcpPlainTextMode=true/);
    assert.match(prefs, /mcpDisabledTools=git,ask_workmate\n/);
    assert.equal(readPid(buildDir).pid, 4242);
    assert.equal(stateOf(buildDir, { alive: () => true }).label, 'ready');
    assert.equal(readProgress(buildDir).edt.phase, 'ready');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdRun с импортом пишет скрипт, зовёт 1cedtcli и помечает импорт', async () => {
  const root = tempRoot();
  try {
    const cf = projectDir(root, 'src/cf');
    const snapshot = snapshotFor(root, { import: 'auto' });
    const buildDir = join(root, 'build');
    writePort(buildDir, 23456);
    writeWorkspaceSnapshot(buildDir, snapshot);
    const captures = [];
    const spawned = [];
    const metadataLog = join(buildDir, 'ws', '.metadata', '.log');
    mkdirSync(join(buildDir, 'ws', '.metadata'), { recursive: true });
    writeFileSync(metadataLog, 'old line\n', 'utf8');
    const code = await cmdRun(root, {}, {
      snapshot,
      detectEdtHome: () => fakeEdt(root),
      resolveEdtVm: () => undefined,
      runCapture: async (command, args) => {
        captures.push({ command, args });
        writeFileSync(
          metadataLog,
          `${readFileSync(metadataLog, 'utf8')}!MESSAGE Project context is being started: cf (EXISTING_DATA_IMPORT)\n!MESSAGE Project context is started: cf\n`,
          'utf8',
        );
      },
      spawnDetached: () => {
        spawned.push(1);
        return { pid: 4242 };
      },
      waitReady: async () => ({ ok: true }),
    });
    assert.equal(code, 0);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].command, join(root, 'fake-1cedtcli'));
    assert.deepEqual(captures[0].args.slice(0, 2), ['-data', join(buildDir, 'ws')]);
    assert.match(readFileSync(join(buildDir, 'import.script'), 'utf8'), new RegExp(`import --project "${cf.replace(/\\/g, '\\\\')}"`));
    assert.equal(existsSync(join(buildDir, 'edt-imported')), true);
    assert.equal(spawned.length, 1);
    assert.match(readFileSync(join(buildDir, 'logs', 'edt-import.log'), 'utf8'), /Project context is started: cf/);
    assert.equal(readProgress(buildDir).edt.phase, 'ready');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdRun: ошибка импорта — failed, EDT не запускается', async () => {
  const root = tempRoot();
  try {
    projectDir(root, 'src/cf');
    const snapshot = snapshotFor(root, { import: true });
    const buildDir = join(root, 'build');
    writePort(buildDir, 23456);
    writeWorkspaceSnapshot(buildDir, snapshot);
    let spawned = 0;
    const code = await cmdRun(root, {}, {
      snapshot,
      detectEdtHome: () => fakeEdt(root),
      runCapture: async () => {
        throw new Error('boom');
      },
      spawnDetached: () => {
        spawned++;
        return { pid: 1 };
      },
      waitReady: async () => ({ ok: true }),
    });
    assert.equal(code, 1);
    assert.equal(spawned, 0);
    assert.equal(stateOf(buildDir, { alive: () => false }).label, 'failed');
    assert.match(readProgress(buildDir).edt.detail, /metadata\/\.log|edt-import\.log/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdRun: нет 1cedtcli — импорт не запускается, failed', async () => {
  const root = tempRoot();
  try {
    projectDir(root, 'src/cf');
    const snapshot = snapshotFor(root, { import: true });
    const buildDir = join(root, 'build');
    writePort(buildDir, 23456);
    writeWorkspaceSnapshot(buildDir, snapshot);
    let launched = 0;
    const code = await cmdRun(root, {}, {
      snapshot,
      detectEdtHome: () => ({ home: root, bin: join(root, 'fake-1cedt'), cli: undefined, mcpBundle: true }),
      runCapture: async () => {
        launched++;
      },
      spawnDetached: () => ({ pid: 1 }),
    });
    assert.equal(code, 1);
    assert.equal(launched, 0);
    assert.match(readProgress(buildDir).edt.detail, /1cedtcli/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdRun: установка EDT не найдена — failed без процессов', async () => {
  const root = tempRoot();
  try {
    const snapshot = snapshotFor(root);
    const buildDir = join(root, 'build');
    writePort(buildDir, 23456);
    writeWorkspaceSnapshot(buildDir, snapshot);
    let spawned = 0;
    const code = await cmdRun(root, {}, {
      snapshot,
      detectEdtHome: () => ({ error: 'нет EDT' }),
      spawnDetached: () => {
        spawned++;
        return { pid: 1 };
      },
    });
    assert.equal(code, 1);
    assert.equal(spawned, 0);
    assert.match(readProgress(buildDir).edt.detail, /нет EDT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdRun: health timeout — failed, но процесс не убиваем', async () => {
  const root = tempRoot();
  try {
    const snapshot = snapshotFor(root);
    const buildDir = join(root, 'build');
    writePort(buildDir, 23456);
    writeWorkspaceSnapshot(buildDir, snapshot);
    const code = await cmdRun(root, {}, {
      snapshot,
      detectEdtHome: () => fakeEdt(root),
      spawnDetached: () => ({ pid: 4242 }),
      waitReady: async () => ({ ok: false, reason: 'timeout', detail: 'boom' }),
    });
    assert.equal(code, 1);
    assert.equal(stateOf(buildDir, { alive: () => true }).label, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdRun не запускает второй run при занятом run-lock', async () => {
  const root = tempRoot();
  try {
    const snapshot = snapshotFor(root);
    const buildDir = join(root, 'build');
    writePort(buildDir, 23456);
    writeWorkspaceSnapshot(buildDir, snapshot);
    writeFileSync(join(buildDir, 'init-run.lock'), JSON.stringify({ pid: process.pid }), 'utf8');
    let spawned = 0;
    const code = await cmdRun(root, {}, {
      snapshot,
      detectEdtHome: () => fakeEdt(root),
      spawnDetached: () => {
        spawned++;
        return { pid: 1 };
      },
    });
    assert.equal(code, 2, 'занятый lock — код 2, чтобы вызывающий не считал запуск успешным');
    assert.equal(spawned, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shouldImport: режимы true/false/auto и смена списка проектов', () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    const base = { buildDir, wsDir: join(buildDir, 'ws'), projects: ['a', 'b'] };
    assert.equal(shouldImport({ ...base, settings: normalizeWorkspaceSettings({ import: false }) }), false);
    assert.equal(shouldImport({ ...base, settings: normalizeWorkspaceSettings({ import: 'auto' }) }), true, 'нет маркера и пустой workspace');

    writeImported(buildDir, ['a', 'b']);
    assert.equal(shouldImport({ ...base, settings: normalizeWorkspaceSettings({ import: 'auto' }) }), false, 'маркер совпадает');

    assert.equal(shouldImport({ ...base, settings: normalizeWorkspaceSettings({ import: true }) }), false, 'список не изменился');
    assert.equal(shouldImport({ ...base, settings: normalizeWorkspaceSettings({ import: true }) }, { force: true }), true);
    assert.equal(
      shouldImport({ ...base, projects: ['a'], settings: normalizeWorkspaceSettings({ import: true }) }),
      true,
      'список проектов изменился',
    );
    assert.equal(
      shouldImport({ ...base, settings: normalizeWorkspaceSettings({ import: 'auto' }) }),
      false,
      'auto не переимпортирует при изменившемся списке — только явный restart',
    );
    assert.equal(shouldImport({ ...base, projects: [], settings: normalizeWorkspaceSettings({ import: true }) }), false);

    // Маркер старого каталога не должен отменять импорт в новый workspace.
    const named = { ...base, wsDir: join(buildDir, 'feature-2520') };
    assert.equal(
      shouldImport({ ...named, settings: normalizeWorkspaceSettings({ import: 'auto' }) }),
      true,
      'маркер build/ws не относится к build/feature-2520',
    );
    assert.equal(shouldImport({ ...named, settings: normalizeWorkspaceSettings({ import: true }) }), true);
    writeImported(buildDir, ['a', 'b'], { wsDir: join(buildDir, 'feature-2520') });
    assert.equal(
      shouldImport({ ...named, settings: normalizeWorkspaceSettings({ import: 'auto' }) }),
      false,
      'маркер нового каталога принимается',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shouldImport: auto не трогает workspace, где проекты уже зарегистрированы', () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    const dir = join(buildDir, 'ws', '.metadata', '.plugins', 'org.eclipse.core.resources', '.projects');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cf'), '', 'utf8');
    assert.equal(
      shouldImport({ buildDir, wsDir: join(buildDir, 'ws'), projects: ['a'], settings: normalizeWorkspaceSettings({ import: 'auto' }) }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdStop: мягкая остановка, затем маркеры сняты', async () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    writePid(buildDir, 4242);
    writeStamp(buildDir, 'ready');
    let alive = true;
    const forces = [];
    const result = await cmdStop(root, {
      alive: () => alive,
      killTree: (_pid, options) => {
        forces.push(options.force);
        alive = false;
      },
      sleep: async () => {},
    });
    assert.equal(result.stopped, true);
    assert.deepEqual(forces, [false]);
    assert.equal(readPid(buildDir), null);
    assert.equal(existsSync(join(buildDir, 'edt-mcp-ready')), false);
    assert.equal(stateOf(buildDir, { alive: () => false }).label, 'stopped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdStop: мёртвый pid — просто чистим маркеры', async () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    writePid(buildDir, 4242);
    const result = await cmdStop(root, { alive: () => false });
    assert.equal(result.stopped, false);
    assert.match(result.reason, /не жив/);
    assert.equal(readPid(buildDir), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdStop без pid ничего не делает', async () => {
  const root = tempRoot();
  try {
    const result = await cmdStop(root, {});
    assert.equal(result.stopped, false);
    assert.match(result.reason, /нет pid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdStopAll останавливает окружения всех worktree репозитория', async () => {
  const root = tempRoot();
  try {
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    for (const [dir, pid] of [[main, 111], [wt, 222]]) {
      writePid(join(dir, 'build'), pid);
      writeStamp(join(dir, 'build'), 'ready');
    }
    const stopped = [];
    const results = await cmdStopAll({ repo: main }, {
      runGit: () => `worktree ${main}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD def\nbranch refs/heads/task\n`,
      alive: (pid) => stopped.every((value) => value !== pid),
      killTree: (pid) => stopped.push(pid),
      sleep: async () => {},
    });
    assert.deepEqual(results.map((item) => item.stopped), [true, true]);
    assert.deepEqual(stopped.sort(), [111, 222]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusReport: строки для человека и данные', () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    const snapshot = snapshotFor(root);
    writeWorkspaceSnapshot(buildDir, snapshot);
    writePort(buildDir, 23456);
    writePid(buildDir, 4242);
    writeImported(buildDir, [join(root, 'src', 'cf')]);
    writeStamp(buildDir, 'ready');
    const report = statusReport(root, { alive: () => true });
    assert.equal(report.state.label, 'ready');
    assert.match(report.lines.join('\n'), /состояние: ready/);
    assert.match(report.lines.join('\n'), /порт: 23456/);
    assert.match(report.lines.join('\n'), /импортировано проектов: 1/);
    assert.equal(report.data.port, 23456);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdInit перехватывает осиротевший run-lock', async () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, 'init-run.lock'), JSON.stringify({ pid: 999999, at: new Date(0).toISOString() }), 'utf8');
    let spawns = 0;
    const code = await cmdInit(root, {}, {
      snapshot: snapshotFor(root),
      pickFreePort: async () => 24589,
      isPortFree: async () => true,
      alive: () => false,
      spawnDetached: () => {
        spawns++;
        return { pid: 1 };
      },
    });
    assert.equal(code, 0);
    assert.equal(spawns, 1);
    assert.match(readFileSync(join(buildDir, 'logs', 'init.log'), 'utf8'), /снят осиротевший run-lock/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdInit: живой run-lock — код 4 и никакого второго run', async () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'init-run.lock'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString(), image: 'node.exe' }),
      'utf8',
    );
    let spawns = 0;
    const code = await cmdInit(root, {}, {
      snapshot: snapshotFor(root),
      pickFreePort: async () => 24589,
      isPortFree: async () => true,
      alive: () => true,
      spawnDetached: () => {
        spawns++;
        return { pid: 1 };
      },
    });
    assert.equal(code, 4);
    assert.equal(spawns, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('waitReady: смерть процесса — ранний process-exited с хвостом edt.log', async () => {
  const root = tempRoot();
  try {
    const log = join(root, 'edt.log');
    writeFileSync(log, 'WARNING: Annotation classes\nERROR: java.lang.UnsupportedClassVersionError\n', 'utf8');
    const result = await waitReady(
      { port: 23456, pid: 4242, alive: () => false, logPath: log, timeoutMs: 60_000 },
      { probeHealth: async () => false, sleep: async () => {}, pollMs: 1, processGraceMs: 0 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'process-exited');
    assert.match(result.detail, /UnsupportedClassVersionError/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('waitHealth: опрашивает до готовности и уважает таймаут', async () => {
  const answers = [false, false, true];
  const ok = await waitHealth(23456, 60_000, {
    probeHealth: async () => answers.shift() ?? false,
    sleep: async () => {},
    pollMs: 1,
  });
  assert.equal(ok, true);

  const timedOut = await waitHealth(23456, 0, { probeHealth: async () => false, sleep: async () => {}, pollMs: 1 });
  assert.equal(timedOut, false);
});

test('cmdInit (CLI): переносит build/ws в каталог ветки и пишет снимок', async () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    const legacy = join(buildDir, 'ws');
    mkdirSync(join(legacy, '.metadata'), { recursive: true });
    writeFileSync(join(legacy, '.metadata', '.log'), 'старое окружение\n', 'utf8');

    const spawns = [];
    const code = await cmdInit(root, {}, {
      currentBranch: () => 'feature/2520',
      pickFreePort: async () => 23456,
      isPortFree: async () => true,
      spawnDetached: (...args) => {
        spawns.push(args);
        return { pid: 111 };
      },
    });
    assert.equal(code, 0);
    assert.equal(existsSync(legacy), false, 'старое место переехало');
    assert.equal(readFileSync(join(buildDir, 'feature-2520', '.metadata', '.log'), 'utf8'), 'старое окружение\n');
    const saved = JSON.parse(readFileSync(join(buildDir, 'workspace.json'), 'utf8'));
    assert.equal(saved.wsDir, join(buildDir, 'feature-2520'));
    assert.match(readFileSync(prefsPath(join(buildDir, 'feature-2520')), 'utf8'), /mcpServerPort=23456/);
    assert.equal(spawns.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdInit (CLI): при запущенном EDT не переименовывает workspace', async () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    const legacy = join(buildDir, 'ws');
    mkdirSync(join(legacy, '.metadata'), { recursive: true });
    writePid(buildDir, 4242);

    let spawned = 0;
    const code = await cmdInit(root, {}, {
      currentBranch: () => 'feature/2520',
      alive: () => true,
      pickFreePort: async () => 23456,
      isPortFree: async () => true,
      spawnDetached: () => {
        spawned += 1;
        return { pid: 1 };
      },
    });
    assert.equal(code, 0);
    assert.equal(spawned, 0, 'окружение уже поднимается');
    assert.equal(existsSync(legacy), true, 'работающий EDT держит файлы — не трогаем');
    assert.equal(existsSync(join(buildDir, 'feature-2520')), false);
    const saved = JSON.parse(readFileSync(join(buildDir, 'workspace.json'), 'utf8'));
    assert.equal(saved.wsDir, legacy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusReport: имя каталога workspace и legacy-подсказка', () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    const snapshot = { ...snapshotFor(root), wsDir: join(buildDir, 'feature-2520') };
    writeWorkspaceSnapshot(buildDir, snapshot);
    let report = statusReport(root, { alive: () => false });
    assert.equal(report.data.workspaceName, 'feature-2520');
    assert.match(report.lines.join('\n'), /имя workspace: feature-2520/);

    writeWorkspaceSnapshot(buildDir, { ...snapshot, wsDir: join(buildDir, 'ws') });
    report = statusReport(root, { alive: () => false });
    assert.match(report.lines.join('\n'), /имя workspace: ws \(старое место/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdInit (CLI): активный run-lock блокирует перенос workspace', async () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    const legacy = join(buildDir, 'ws');
    mkdirSync(join(legacy, '.metadata'), { recursive: true });
    writeFileSync(join(buildDir, 'init-run.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
    writeWorkspaceSnapshot(buildDir, { ...snapshotFor(root), wsDir: legacy });

    const code = await cmdInit(root, {}, {
      currentBranch: () => 'feature/2520',
      alive: () => true,
      spawnDetached: () => {
        throw new Error('run не должен запускаться');
      },
    });
    assert.equal(code, 4, 'импорт уже идёт');
    assert.equal(existsSync(legacy), true, 'каталог работает — не переименовываем');
    assert.equal(existsSync(join(buildDir, 'feature-2520')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runLockActive: живой run-lock считается запуском, мёртвый и просроченный — нет', () => {
  const root = tempRoot();
  try {
    const buildDir = join(root, 'build');
    mkdirSync(buildDir, { recursive: true });
    const lock = join(buildDir, 'init-run.lock');
    const now = new Date().toISOString();

    writeFileSync(lock, JSON.stringify({ pid: 4242, at: now }), 'utf8');
    assert.equal(runLockActive(buildDir, {}, { alive: () => true }), true);
    assert.equal(runLockActive(buildDir, {}, { alive: () => false }), false, 'мёртвый pid — lock осиротел');
    writeFileSync(lock, JSON.stringify({ pid: 4242, at: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() }), 'utf8');
    assert.equal(runLockActive(buildDir, {}, { alive: () => true }), false, 'просроченный lock не держит');

    rmSync(lock, { force: true });
    assert.equal(runLockActive(buildDir, {}, { alive: () => true }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
