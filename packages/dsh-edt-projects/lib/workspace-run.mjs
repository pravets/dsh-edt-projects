#!/usr/bin/env node
// Фоновый подъём и остановка EDT-окружения worktree.
//
// Запускается плагином (lib/index.js) и CLI (tools/edt-workspace.mjs):
//   node lib/workspace-run.mjs init   --root <worktree>
//   node lib/workspace-run.mjs run    --root <worktree> [--import]
//   node lib/workspace-run.mjs status --root <worktree> [--json]
//   node lib/workspace-run.mjs stop   --root <worktree>
//   node lib/workspace-run.mjs stop-all --repo <repository>
//
// `init` быстрый: занимает порт, пишет prefs и запускает `run` отсоединённым
// процессом. Долгие шаги (импорт 1cedtcli, старт EDT, ожидание /health) живут
// в `run`, поэтому DSH не блокируется, а окружение переживает перезапуск DSH.
// Все зависимости, которые трогают процессы и время, передаются через `deps` —
// так сценарии проверяются без запуска настоящего EDT.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildWorkspaceSnapshot,
  clearProgress,
  detectEdtHome,
  discoverProjects,
  filePath,
  formatElapsed,
  guiArgs,
  importArgs,
  importScriptText,
  isPortFree,
  killTree,
  normalizeWorkspaceSettings,
  pickFreePort,
  pidAlive,
  probeHealth,
  readImported,
  readPid,
  readPort,
  readWorkspaceSnapshot,
  registeredProjectsDir,
  resolveEdtVm,
  stateOf,
  tailFile,
  writeImported,
  writePid,
  writePort,
  writePrefs,
  writeProgress,
  writeStamp,
  removeStamp,
  writeWorkspaceSnapshot,
} from './workspace.mjs';

const execFileAsync = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const HEALTH_POLL_MS = 2000;
const STOP_GRACE_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Дописывает строку в build/logs/init.log; в терминале (TTY) ещё и печатает. */
export function logTo(buildDir, message, now = new Date()) {
  const line = `[${now.toISOString()}] ${message}`;
  try {
    mkdirSync(path.join(buildDir, 'logs'), { recursive: true });
    writeFileSync(path.join(buildDir, 'logs', 'init.log'), `${line}\n`, { encoding: 'utf8', flag: 'a' });
  } catch {
    // лог — вспомогательный: его недоступность не должна ломать подъём
  }
  // У фонового процесса stdout перенаправлен в тот же файл — печатать нельзя,
  // иначе каждая строка попадёт в лог дважды.
  if (process.stdout?.isTTY === true) console.log(line);
}

/** Разбирает argv CLI. */
export function parseArgs(argv = []) {
  const action = argv.find((item) => !item.startsWith('-')) ?? 'init';
  const valueOf = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const importIndex = argv.indexOf('--import');
  return {
    action,
    root: valueOf('--root'),
    repo: valueOf('--repo'),
    json: argv.includes('--json'),
    import: importIndex === -1 ? undefined : argv.slice(importIndex + 1).find((item) => !item.startsWith('-')) ?? true,
  };
}

/** Запускает процесс отсоединённым, весь вывод — в файл. */
export function spawnDetached(command, args, logPath, cwd, deps = {}) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const out = openSync(logPath, 'a');
  let child;
  try {
    child = (deps.spawn ?? spawn)(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
  } finally {
    closeSync(out);
  }
  if (child?.pid) child.unref();
  return child;
}

/** Запускает команду с выводом в лог, дожидаясь завершения. */
export async function runCapture(command, args, logPath, deps = {}) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const out = openSync(logPath, 'a');
  try {
    await (deps.runCapture ??
      ((cmd, argv, options) => execFileAsync(cmd, argv, { ...options, encoding: 'utf8' }).then(() => undefined)))(
      command,
      args,
      { stdio: ['ignore', out, out], windowsHide: true },
    );
  } finally {
    closeSync(out);
  }
}

function lockInfo(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Захватывает lock; чужой живой lock — сигнал «уже идёт». */
export function acquireLock(file, deps = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const alive = deps.alive ?? ((pid) => pidAlive(pid));
  const existing = lockInfo(file);
  if (existing?.pid !== undefined) {
    if (alive(existing.pid)) return false;
    try {
      unlinkSync(file);
    } catch {
      // lock мог уже исчезнуть
    }
  }
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(file) {
  const info = lockInfo(file);
  if (info === null || info.pid === process.pid) {
    try {
      unlinkSync(file);
    } catch {
      // lock уже снят
    }
  }
}

/** Нужно ли импортировать проекты в этот workspace. */
export function shouldImport(snapshot, { force } = {}, deps = {}) {
  const settings = snapshot.settings;
  const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
  if (projects.length === 0) return false;
  if (force === true || snapshot.forceImport === true) return true;
  if (settings.import === false) return false;

  const imported = deps.readImported ?? readImported;
  const marker = imported(snapshot.buildDir);
  const same =
    marker !== null &&
    Array.isArray(marker.projects) &&
    marker.projects.length === projects.length &&
    marker.projects.every((item, index) => item === projects[index]);
  if (same) return false;
  if (settings.import === true) return true;
  if (marker !== null) return true;

  // "auto": workspace уже с проектами (например, их импортировали руками) —
  // повторный импорт не нужен и может конфликтовать с открытой EDT.
  const registered = deps.hasRegisteredProjects ?? defaultHasRegisteredProjects;
  return !registered(registeredProjectsDir(snapshot.buildDir));
}

function defaultHasRegisteredProjects(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function snapshotOrThrow(root) {
  const buildDir = path.join(root, 'build');
  const snapshot = readWorkspaceSnapshot(buildDir);
  if (snapshot === undefined) {
    throw new Error(`нет ${path.join(buildDir, 'workspace.json')} — окружение ещё не готовили; вызовите init`);
  }
  return snapshot;
}

/** Снимок по умолчанию для CLI, когда workspace.json ещё нет. */
export function defaultSnapshot(root, env = process.env) {
  const settings = normalizeWorkspaceSettings({}, env);
  const buildDir = path.join(root, 'build');
  return buildWorkspaceSnapshot({
    root,
    buildDir,
    wsDir: path.join(buildDir, 'ws'),
    mainRoot: undefined,
    settings,
    projects: discoverProjects(root, settings.projects),
  });
}

/**
 * `init`: быстро занимает порт, пишет prefs и запускает `run` в фоне.
 * @returns {Promise<number>} код возврата.
 */
export async function cmdInit(root, args = {}, deps = {}) {
  const snapshot = deps.snapshot ?? readWorkspaceSnapshot(path.join(root, 'build')) ?? defaultSnapshot(root);
  const buildDir = snapshot.buildDir;
  mkdirSync(buildDir, { recursive: true });
  writeWorkspaceSnapshot(buildDir, snapshot);

  const state = stateOf(buildDir, { alive: deps.alive });
  if (state.label === 'ready' || state.label === 'starting') {
    logTo(buildDir, `init: окружение уже ${state.label === 'ready' ? 'готово' : 'поднимается'}, делать нечего`);
    return 0;
  }

  const lock = filePath(buildDir, 'lock');
  if (!acquireLock(lock, deps)) {
    logTo(buildDir, 'init: другой процесс уже занимает порт, выходим');
    return 0;
  }
  try {
    let port = readPort(buildDir);
    const free = deps.isPortFree ?? isPortFree;
    if (port === null || !(await free(port))) {
      port = await (deps.pickFreePort ?? pickFreePort)(snapshot.settings.ports, { isFree: free });
      writePort(buildDir, port);
    }
    const prefs = writePrefs(buildDir, port);
    logTo(buildDir, `init: порт ${port}, prefs ${path.relative(root, prefs)}, запускаю run в фоне`);
    const logPath = path.join(buildDir, 'logs', 'init.log');
    (deps.spawnDetached ?? spawnDetached)(process.execPath, [SELF, 'run', '--root', root], logPath, root, deps);
  } finally {
    releaseLock(lock);
  }
  return 0;
}

/**
 * `run`: импорт проектов, prefs, старт EDT и ожидание готовности.
 * @returns {Promise<number>}
 */
export async function cmdRun(root, args = {}, deps = {}) {
  const snapshot = deps.snapshot ?? readWorkspaceSnapshot(path.join(root, 'build'));
  if (snapshot === undefined) {
    console.error('run: нет workspace.json — сначала init');
    return 1;
  }
  const buildDir = snapshot.buildDir;
  const settings = snapshot.settings;
  const log = (message) => logTo(buildDir, message, deps.now?.());
  mkdirSync(path.join(buildDir, 'logs'), { recursive: true });

  const lock = filePath(buildDir, 'runLock');
  if (!acquireLock(lock, deps)) {
    log('run: другой запуск уже идёт, выходим');
    return 0;
  }

  try {
    const state = stateOf(buildDir, { alive: deps.alive });
    if (state.label === 'ready') {
      log('run: окружение уже готово');
      return 0;
    }

    const detected = (deps.detectEdtHome ?? detectEdtHome)(settings, deps);
    if (detected?.error !== undefined || detected?.home === undefined) {
      writeProgress(buildDir, 'edt', 'failed', detected?.error ?? 'установка EDT не найдена');
      writeStamp(buildDir, 'failed', deps.now?.());
      log(`edt: FAILED: ${detected?.error ?? 'установка EDT не найдена'}`);
      return 1;
    }
    if (detected.mcpBundle !== true) {
      log('edt: предупреждение — в установке не найден бандл EDT-MCP (проверьте plugins/features)');
    }

    const port = readPort(buildDir);
    if (port === null) {
      writeProgress(buildDir, 'edt', 'failed', 'нет порта: init не отработал');
      writeStamp(buildDir, 'failed', deps.now?.());
      log('edt: FAILED: нет файла порта');
      return 1;
    }

    const importNeeded = (deps.shouldImport ?? shouldImport)(snapshot, { force: args.import === true }, deps);
    if (importNeeded) {
      const scriptPath = writeImportScript(buildDir, snapshot.projects);
      writeProgress(buildDir, 'edt', 'importing', tailFile(path.join(buildDir, 'logs', 'edt-import.log')));
      log(`edt: импорт ${snapshot.projects.length} проект(ов) в ${path.relative(root, snapshot.wsDir)} (xmx ${settings.xmxImport}, timeout ${settings.importTimeout}s)`);
      const ticker = setInterval(() => {
        const detail = tailFile(path.join(buildDir, 'logs', 'edt-import.log'));
        if (detail) writeProgress(buildDir, 'edt', 'importing', detail);
      }, 10_000);
      ticker.unref?.();
      try {
        await (deps.runCapture ?? runCapture)(
          detected.cli ?? detected.bin,
          importArgs({ ...snapshot, wsDir: snapshot.wsDir, timeout: settings.importTimeout, xmxImport: settings.xmxImport }, scriptPath),
          path.join(buildDir, 'logs', 'edt-import.log'),
          deps,
        );
      } catch (error) {
        clearInterval(ticker);
        const tail = tailFile(path.join(buildDir, 'logs', 'edt-import.log'));
        writeProgress(buildDir, 'edt', 'import-failed', `${tail ?? error?.message ?? error}; см. build/logs/edt-import.log`);
        writeStamp(buildDir, 'failed', deps.now?.());
        log(`edt: FAILED: импорт не удался — ${error?.message ?? error}; лог build/logs/edt-import.log`);
        return 1;
      }
      clearInterval(ticker);
      writeImported(buildDir, snapshot.projects, deps.now?.());
      log('edt: импорт завершён');
      if (snapshot.forceImport === true) {
        const { forceImport, ...rest } = snapshot;
        writeWorkspaceSnapshot(buildDir, rest);
      }
    } else {
      log('edt: импорт не требуется');
    }

    writePrefs(buildDir, port);
    const runningPid = readPid(buildDir)?.pid;
    if (runningPid !== undefined && (deps.alive ?? ((pid) => pidAlive(pid, ['1cedt'])))(runningPid)) {
      log(`edt: уже запущен (pid ${runningPid})`);
    } else {
      const vm = (deps.resolveEdtVm ?? resolveEdtVm)(settings, detected.home, deps);
      writeProgress(buildDir, 'edt', 'gui');
      const gui = (deps.spawnDetached ?? spawnDetached)(
        detected.bin,
        guiArgs({ wsDir: snapshot.wsDir, xmx: settings.xmxIde, vm }),
        path.join(buildDir, 'logs', 'edt.log'),
        root,
        deps,
      );
      if (!gui?.pid) {
        writeProgress(buildDir, 'edt', 'failed', 'не удалось запустить 1cedt');
        writeStamp(buildDir, 'failed', deps.now?.());
        log('edt: FAILED: не удалось запустить 1cedt');
        return 1;
      }
      writePid(buildDir, gui.pid, deps.now?.());
      log(`edt: запущен pid ${gui.pid} (workspace ${snapshot.wsDir})`);
    }

    removeStamp(buildDir, 'ready');
    writeProgress(buildDir, 'edt', 'health');
    log(`edt: жду /health на порту ${port} (до ${Math.round(settings.startTimeout / 60)} мин)`);
    const ready = await (deps.waitHealth ?? waitHealth)(port, settings.startTimeout * 1000, deps);
    if (ready) {
      writeProgress(buildDir, 'edt', 'ready');
      writeStamp(buildDir, 'ready', deps.now?.());
      removeStamp(buildDir, 'failed');
      log('edt: READY');
      return 0;
    }
    writeProgress(buildDir, 'edt', 'failed', 'health timeout');
    writeStamp(buildDir, 'failed', deps.now?.());
    log('edt: FAILED: health timeout');
    return 1;
  } finally {
    releaseLock(lock);
  }
}

function writeImportScript(buildDir, projects) {
  const file = filePath(buildDir, 'script');
  writeFileSync(file, importScriptText(projects), 'utf8');
  return file;
}

/** Ждёт /health до истечения таймаута. */
export async function waitHealth(port, timeoutMs, deps = {}) {
  const probe = deps.probeHealth ?? probeHealth;
  const delay = deps.sleep ?? sleep;
  const pollMs = deps.pollMs ?? HEALTH_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port, deps)) return true;
    await delay(pollMs);
  }
  return false;
}

/** Останавливает EDT этого worktree. */
export async function cmdStop(root, deps = {}) {
  const buildDir = path.join(root, 'build');
  const pidInfo = readPid(buildDir);
  if (pidInfo === null) {
    clearProgress(buildDir);
    return { stopped: false, reason: 'нет pid — нечего останавливать' };
  }
  const alive = deps.alive ?? ((pid) => pidAlive(pid, ['1cedt']));
  const pid = pidInfo.pid;
  if (!alive(pid)) {
    clearState(buildDir);
    return { stopped: false, reason: `pid ${pid} уже не жив` };
  }

  (deps.killTree ?? killTree)(pid, { force: false, ...deps });
  const delay = deps.sleep ?? sleep;
  const deadline = Date.now() + STOP_GRACE_MS;
  while (alive(pid) && Date.now() < deadline) await delay(300);
  if (alive(pid)) (deps.killTree ?? killTree)(pid, { force: true, ...deps });
  clearState(buildDir);
  return { stopped: true, pid };
}

function clearState(buildDir) {
  for (const key of ['ready', 'failed', 'pid']) removeStamp(buildDir, key);
  clearProgress(buildDir);
}

/** Останавливает окружения всех worktree репозитория. */
export async function cmdStopAll({ repo, root }, deps = {}) {
  const run = deps.runGit ?? ((dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }));
  const list = run(root ?? repo, ['worktree', 'list', '--porcelain']);
  const roots = [];
  for (const line of String(list).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) roots.push(line.slice('worktree '.length).trim());
  }
  const results = [];
  for (const worktree of roots) {
    const pid = readPid(path.join(worktree, 'build'));
    if (pid === null) continue;
    results.push({ worktree, ...(await cmdStop(worktree, deps)) });
  }
  return results;
}

/** Текстовый отчёт о состоянии (CLI и тесты). */
export function statusReport(root, deps = {}) {
  const buildDir = path.join(root, 'build');
  const snapshot = readWorkspaceSnapshot(buildDir);
  const state = stateOf(buildDir, { alive: deps.alive });
  const progress = state.progress?.edt;
  const lines = [
    `worktree: ${root}`,
    `состояние: ${state.label}`,
    `workspace: ${snapshot?.wsDir ?? path.join(buildDir, 'ws')}`,
    `порт: ${state.port ?? '-'}  pid: ${state.pid?.pid ?? '-'}`,
  ];
  if (progress?.phase) {
    lines.push(`фаза: ${progress.phase}${progress.since ? ` (${formatElapsed(progress.since)})` : ''}${progress.detail ? ` — ${progress.detail}` : ''}`);
  }
  if (state.imported?.projects) lines.push(`импортировано проектов: ${state.imported.projects.length}`);
  lines.push(`логи: ${path.join(buildDir, 'logs')}`);
  return { root, buildDir, snapshot, state, lines, data: { ...state, workspace: snapshot?.wsDir, root } };
}

/** Точка входа CLI. */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const root = args.root ?? process.cwd();
  switch (args.action) {
    case 'init':
      return cmdInit(root, args, deps);
    case 'run':
      return cmdRun(root, args, deps);
    case 'status': {
      const report = statusReport(root, deps);
      if (args.json) console.log(JSON.stringify(report.data, null, 2));
      else for (const line of report.lines) console.log(line);
      return 0;
    }
    case 'stop': {
      const result = await cmdStop(root, deps);
      console.log(result.stopped ? `остановлен pid ${result.pid}` : `не остановлен: ${result.reason}`);
      return 0;
    }
    case 'stop-all': {
      const results = await cmdStopAll({ repo: args.repo ?? root, root: args.root }, deps);
      console.log(JSON.stringify(results, null, 2));
      return 0;
    }
    default:
      console.log('usage: node lib/workspace-run.mjs [init|run|status|stop|stop-all] [--root <dir>] [--repo <dir>] [--import] [--json]');
      return 2;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((error) => {
      console.error(`workspace-run: ${error?.message ?? error}`);
      process.exit(1);
    });
}
