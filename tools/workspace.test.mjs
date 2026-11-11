// Тесты окружения EDT worktree: настройки, цель, проекты, порт, файлы
// состояния, определение установки EDT и готовность.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import {
  detectEdtHome,
  discoverProjects,
  expandProjectPattern,
  filePath,
  formatElapsed,
  guiArgs,
  hasMcpBundle,
  healthUrl,
  importArgs,
  importDigest,
  importMemoryWarning,
  importScriptText,
  isPortFree,
  mcpEvidence,
  mergePrefsText,
  normalizeWorkspaceSettings,
  parseImportProgress,
  pickFreePort,
  prefsPath,
  prepareWorkspaceSnapshot,
  probeHealth,
  readFromOffset,
  readPort,
  removeStamp,
  requiredJava,
  resolveEdtVm,
  resolveWorkspaceTarget,
  stateOf,
  tailFile,
  writePort,
  writePrefs,
  writeProgress,
  writeStamp,
  writePid,
} from '../packages/dsh-edt-projects/lib/workspace.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'ws-test-'));
const touch = (file, content = '') => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content, 'utf8');
};
const projectDir = (root, rel) => {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.project'), '', 'utf8');
  return dir;
};

test('normalizeWorkspaceSettings: значения по умолчанию и пустая секция', () => {
  const settings = normalizeWorkspaceSettings({});
  assert.equal(settings.enabled, true);
  assert.equal(settings.import, 'auto');
  assert.deepEqual(settings.ports, { min: 20000, max: 39999 });
  assert.equal(settings.stopOnSessionEnd, true);
  assert.deepEqual(settings.projects, []);
  assert.equal(settings.xmxIde, '6g');
});

test('normalizeWorkspaceSettings: env перекрывает import и читает настройки', () => {
  const on = normalizeWorkspaceSettings({ import: false, root: ' repo ', xmxIde: '3g' }, { DSH_1C_EDT_IMPORT: '1' });
  assert.equal(on.import, true);
  assert.equal(on.root, 'repo');
  assert.equal(on.xmxIde, '3g');

  const off = normalizeWorkspaceSettings({ import: true }, { DSH_1C_EDT_IMPORT: '0' });
  assert.equal(off.import, false);

  const bad = normalizeWorkspaceSettings({ import: 'yes', ports: { min: 90000, max: 1000 }, startTimeout: -1 });
  assert.equal(bad.import, 'auto');
  assert.deepEqual(bad.ports, { min: 1000, max: 20000 }, 'некорректная граница заменяется на дефолт, порядок выправляется');
  assert.equal(bad.startTimeout, 1800);
});

const worktree = (root, mainRoot = join(root, '..', 'main')) => ({
  root,
  mainRoot,
  isWorktree: true,
});

test('resolveWorkspaceTarget: выключено, основной checkout, нет репозитория', () => {
  const dir = tempDir();
  try {
    assert.equal(resolveWorkspaceTarget({ cwd: dir, config: { workspace: { enabled: false } } }).state, 'off');
    assert.equal(resolveWorkspaceTarget({ cwd: dir, config: {} }).reason, 'no-repository');

    const main = { ...worktree(join(dir, 'main')), isWorktree: false };
    assert.equal(resolveWorkspaceTarget({ cwd: dir, config: {}, repositories: [main] }).state, 'off');
    assert.equal(resolveWorkspaceTarget({ cwd: dir, config: {}, repositories: [main] }).reason, 'main-checkout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceTarget: worktree — build/ws и порт по умолчанию', () => {
  const dir = tempDir();
  try {
    const root = join(dir, 'wt');
    const target = resolveWorkspaceTarget({ cwd: root, config: {}, repositories: [worktree(root)] });
    assert.equal(target.state, 'ok');
    assert.equal(target.root, root);
    assert.equal(target.buildDir, join(root, 'build'));
    assert.equal(target.wsDir, join(root, 'build', 'ws'));
    assert.equal(target.rootSource, 'repo');
    assert.deepEqual(target.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceTarget: workspace.root относительный и абсолютный', () => {
  const dir = tempDir();
  try {
    const root = join(dir, 'wt');
    const relative = resolveWorkspaceTarget({ cwd: root, config: { workspace: { root: 'src' } }, repositories: [worktree(root)] });
    assert.equal(relative.root, join(root, 'src'));
    assert.equal(relative.rootSource, 'config');

    const absolute = resolveWorkspaceTarget({ cwd: root, config: { workspace: { root: join(dir, 'shared') } }, repositories: [worktree(root)] });
    assert.equal(absolute.root, join(dir, 'shared'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceTarget: несколько worktree — первый и предупреждение', () => {
  const dir = tempDir();
  try {
    const first = join(dir, 'a');
    const second = join(dir, 'b');
    const target = resolveWorkspaceTarget({ cwd: dir, config: {}, repositories: [worktree(first), worktree(second)] });
    assert.equal(target.root, first);
    assert.equal(target.warnings.length, 1);
    assert.match(target.warnings[0], /workspace\.root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverProjects: автопоиск до трёх уровней, build и скрытые пропускаются', () => {
  const dir = tempDir();
  try {
    const expected = [
      projectDir(dir, 'src/cf'),
      projectDir(dir, 'src/cfe/one'),
      projectDir(dir, 'tests/yaxunit/suite'),
    ];
    projectDir(dir, 'build/ws/ignored');
    projectDir(dir, '.hidden/ignored');
    projectDir(dir, 'deep/level/three/four/ignored');
    assert.deepEqual(discoverProjects(dir), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverProjects: корень сам проект', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, '.project'), '', 'utf8');
    assert.deepEqual(discoverProjects(dir), [dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverProjects: шаблоны, абсолютные пути и дедупликация', () => {
  const dir = tempDir();
  try {
    const a = projectDir(dir, 'src/cfe/a');
    const b = projectDir(dir, 'src/cfe/b');
    const cf = projectDir(dir, 'src/cf');
    assert.deepEqual(discoverProjects(dir, ['src/cf', 'src/cfe/*', 'src/cfe/a']), [cf, a, b].sort((l, r) => l.localeCompare(r)));
    assert.deepEqual(expandProjectPattern(dir, 'src/cfe/*'), [a, b]);
    assert.deepEqual(discoverProjects(dir, [join(dir, 'src', 'cf')]), [cf]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importScriptText: по строке на проект, кавычки сохраняются', () => {
  assert.equal(importScriptText(['C:/prj/one', 'D:/two words']), 'import --project "C:/prj/one"\nimport --project "D:/two words"\n');
  assert.equal(importScriptText([]), '');
  assert.equal(importScriptText([null, '', ' x ']), 'import --project " x "\n');
});

test('prefs: mergePrefsText сохраняет чужие ключи и кодировку строк', () => {
  const out = mergePrefsText('eclipse.preferences.version=1\nmcpToolPrefsMigration=4\nmcpServerPort=1\n', {
    mcpServerPort: 24676,
    mcpServerAutoStart: 'true',
  });
  assert.match(out, /^eclipse\.preferences\.version=1\n/);
  assert.match(out, /mcpToolPrefsMigration=4\n/);
  assert.match(out, /mcpServerPort=24676\n/);
  assert.match(out, /mcpServerAutoStart=true\n/);
  assert.equal((out.match(/eclipse\.preferences\.version/g) ?? []).length, 1);
  assert.match(mergePrefsText('a=1\r\nb=2\r\n', { c: 3 }), /a=1\nb=2\nc=3\n/);
});

test('writePrefs пишет файл в workspace', () => {
  const dir = tempDir();
  try {
    const buildDir = join(dir, 'build');
    const file = writePrefs(buildDir, 23456);
    assert.equal(file, prefsPath(buildDir));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /mcpServerAutoStart=true/);
    assert.match(text, /mcpServerPort=23456/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pickFreePort: уходит от занятых и бросает при исчерпании', async () => {
  const port = await pickFreePort({ min: 21000, max: 21009 }, { isFree: async (value) => value > 21005, used: new Set([21000, 21001]) });
  assert.ok(port > 21005 && port <= 21009);
  await assert.rejects(pickFreePort({ min: 21000, max: 21001 }, { isFree: async () => false }), /нет свободного порта/);
  await assert.rejects(pickFreePort({ min: 0, max: 1 }), /некорректный диапазон/);
});

test('isPortFree: занятый и свободный порт', async () => {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await isPortFree(port), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await isPortFree(port), true);
});

test('stateOf: absent/stopped/starting/ready/stale/failed', () => {
  const dir = tempDir();
  try {
    const buildDir = join(dir, 'build');
    assert.equal(stateOf(buildDir, { alive: () => false }).label, 'absent');

    mkdirSync(buildDir, { recursive: true });
    writePort(buildDir, 23456);
    assert.equal(stateOf(buildDir, { alive: () => false }).label, 'stopped');
    assert.equal(readPort(buildDir), 23456);

    writePid(buildDir, 4242);
    assert.equal(stateOf(buildDir, { alive: () => true }).label, 'starting');

    writeStamp(buildDir, 'ready');
    assert.equal(stateOf(buildDir, { alive: () => true }).label, 'ready');
    assert.equal(stateOf(buildDir, { alive: () => false }).label, 'stale');

    writeStamp(buildDir, 'failed');
    assert.equal(stateOf(buildDir, { alive: () => true }).label, 'failed');
    removeStamp(buildDir, 'failed');
    removeStamp(buildDir, 'ready');
    assert.equal(stateOf(buildDir, { alive: () => false }).label, 'stopped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeProgress: since держится при той же фазе и сбрасывается при смене', () => {
  const dir = tempDir();
  try {
    const buildDir = join(dir, 'build');
    const firstAt = new Date('2026-01-01T00:00:00.000Z');
    const secondAt = new Date('2026-01-01T00:00:01.000Z');
    const thirdAt = new Date('2026-01-01T00:00:02.000Z');
    writeProgress(buildDir, 'edt', 'importing', undefined, firstAt);
    const first = stateOf(buildDir, { alive: () => false }).progress.edt;
    assert.equal(first.since, firstAt.toISOString());
    writeProgress(buildDir, 'edt', 'importing', 'next', secondAt);
    const second = stateOf(buildDir, { alive: () => false }).progress.edt;
    assert.equal(second.since, firstAt.toISOString(), 'та же фаза — since не меняется');
    assert.equal(second.updated, secondAt.toISOString());
    assert.equal(second.detail, 'next');
    writeProgress(buildDir, 'edt', 'health', undefined, thirdAt);
    const third = stateOf(buildDir, { alive: () => false }).progress.edt;
    assert.equal(third.since, thirdAt.toISOString(), 'смена фазы — новый since');
    assert.equal(third.detail, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareWorkspaceSnapshot: пути, проекты и настройки', () => {
  const dir = tempDir();
  try {
    projectDir(dir, 'src/cf');
    const settings = normalizeWorkspaceSettings({});
    const snapshot = prepareWorkspaceSnapshot({ root: dir, mainRoot: join(dir, '..', 'main'), settings });
    assert.equal(snapshot.buildDir, join(dir, 'build'));
    assert.equal(snapshot.wsDir, join(dir, 'build', 'ws'));
    assert.deepEqual(snapshot.projects, [join(dir, 'src', 'cf')]);
    assert.equal(snapshot.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectEdtHome: явная настройка и DSH_1C_EDT_HOME', () => {
  const dir = tempDir();
  try {
    const home = join(dir, '1c-edt-2026.1.2+2-x86_64');
    touch(join(home, '1cedt.exe'));
    const fromConfig = detectEdtHome(normalizeWorkspaceSettings({ home: { win32: home } }), { platform: 'win32', env: {}, eclipseRoots: [] });
    assert.equal(fromConfig.home, home);
    assert.equal(fromConfig.source, 'config');
    assert.equal(fromConfig.mcpBundle, false);
    assert.equal(fromConfig.cli, undefined, 'без 1cedtcli импорт невозможен');

    touch(join(home, '1cedtcli.exe'));
    const withCli = detectEdtHome(normalizeWorkspaceSettings({ home: { win32: home } }), { platform: 'win32', env: {}, eclipseRoots: [] });
    assert.equal(withCli.cli, join(home, '1cedtcli.exe'));

    const fromEnv = detectEdtHome(normalizeWorkspaceSettings({}), { platform: 'win32', env: { DSH_1C_EDT_HOME: home }, eclipseRoots: [] });
    assert.equal(fromEnv.source, 'env');

    const missing = detectEdtHome(normalizeWorkspaceSettings({ home: { win32: join(dir, 'none') } }), { platform: 'win32', env: {}, eclipseRoots: [] });
    assert.match(missing.error, /1cedt\.exe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectEdtHome: автопоиск старшей версии и предпочтение установке с EDT-MCP', () => {
  const dir = tempDir();
  try {
    const roots = [dir];
    const older = join(dir, '1c-edt-2025.2.3+30-x86_64');
    touch(join(older, '1cedt.exe'));
    const newer = join(dir, '1c-edt-2026.1.2+2-x86_64');
    touch(join(newer, '1cedt.exe'));
    touch(join(newer, 'plugins', 'com.ditrix.edt.mcp.server_1.27.0', 'plugin.xml'));
    touch(join(dir, '1c-edt-start-0.10.0+448-x86_64', '1cedtstart.exe'));

    const chosen = detectEdtHome(normalizeWorkspaceSettings({}), { platform: 'win32', env: {}, roots, eclipseRoots: [] });
    assert.equal(chosen.home, newer);
    assert.equal(chosen.mcpBundle, true);
    assert.equal(hasMcpBundle(older, { platform: 'win32', eclipseRoots: [] }), false);

    const none = detectEdtHome(normalizeWorkspaceSettings({}), { platform: 'win32', env: {}, roots: [join(dir, 'empty')] });
    assert.match(none.error, /не найден/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveEdtVm: явная настройка, env и автопоиск jdk-full-17', () => {
  const dir = tempDir();
  try {
    const components = join(dir, 'components');
    const home = join(components, '1c-edt-2026.1.2+2-x86_64');
    touch(join(home, '1cedt.exe'));
    const jdk = join(components, 'axiom-jdk-full-17.0.16+12-x86_64', 'bin');
    touch(join(jdk, 'javaw.exe'));
    touch(join(components, 'liberica-jdk-full-11.0.13+10-x86_64', 'bin', 'javaw.exe'));

    assert.equal(resolveEdtVm(normalizeWorkspaceSettings({}), home, { platform: 'win32', env: {} }), join(jdk, 'javaw.exe'));
    assert.equal(resolveEdtVm(normalizeWorkspaceSettings({ vm: 'C:/jdk/bin/java' }), home, { platform: 'win32', env: {} }), 'C:/jdk/bin/java');
    assert.equal(
      resolveEdtVm(normalizeWorkspaceSettings({}), home, { platform: 'win32', env: { DSH_1C_EDT_VM: 'D:/env/java' } }),
      'D:/env/java',
    );
    assert.equal(resolveEdtVm(normalizeWorkspaceSettings({}), undefined, { platform: 'win32', env: {} }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guiArgs/importArgs: отдельный workspace, Xmx и -vm', () => {
  assert.deepEqual(guiArgs({ wsDir: 'C:/wt/build/ws', xmx: '6g', vm: 'C:/jdk/javaw.exe' }), [
    '-nosplash',
    '-data',
    'C:/wt/build/ws',
    '--launcher.appendVmargs',
    '-vm',
    'C:/jdk/javaw.exe',
    '-vmargs',
    '-Xmx6g',
  ]);
  assert.deepEqual(guiArgs({ wsDir: 'ws', xmx: '4g' }).slice(-2), ['-vmargs', '-Xmx4g']);
  assert.deepEqual(importArgs({ wsDir: 'ws', timeout: 3600, xmxImport: '8g' }, 's.script'), [
    '-data',
    'ws',
    '-timeout',
    '3600',
    '-vmargs',
    '-Xmx8g',
    '-file',
    's.script',
  ]);
});

test('probeHealth: отвечает на /health и терпит ошибки', async () => {
  assert.equal(healthUrl(23456), 'http://127.0.0.1:23456/health');
  const ok = await probeHealth(23456, { fetchImpl: async () => ({ status: 200 }) });
  assert.equal(ok, true);
  const serverError = await probeHealth(23456, { fetchImpl: async () => ({ status: 500 }) });
  assert.equal(serverError, false);
  const failed = await probeHealth(23456, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(failed, false);
  assert.equal(await probeHealth(null, { fetchImpl: async () => ({ status: 200 }) }), false);
});

test('tailFile и formatElapsed', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'one\r\n\r\ntwo\n', 'utf8');
    assert.equal(tailFile(file), 'two');
    writeFileSync(file, `${'x'.repeat(300)}\n`, 'utf8');
    assert.equal(tailFile(file).length, 200);
    assert.equal(tailFile(join(dir, 'missing')), null);
    const now = Date.parse('2026-09-03T12:00:00Z');
    assert.equal(formatElapsed('2026-09-03T11:55:48Z', now), '4m 12s');
    assert.equal(formatElapsed('2026-09-03T11:59:59Z', now), '1s');
    assert.equal(formatElapsed('bogus', now), '?');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requiredJava читает major и -vm из 1cedt.ini', () => {
  const dir = tempDir();
  try {
    const home = join(dir, '1c-edt-2026.2.2+21-x86_64');
    touch(join(home, '1cedt.exe'));
    const vm = join(dir, 'jdk-25', 'bin', 'javaw.exe');
    writeFileSync(join(home, '1cedt.ini'), `-vm\n${vm}\n-vmargs\n-Dosgi.requiredJavaVersion=25\n`, 'utf8');
    const required = requiredJava(home);
    assert.equal(required.major, 25);
    assert.equal(required.vm, path.normalize(vm));
    assert.deepEqual(requiredJava(join(dir, 'missing')), { major: undefined, vm: undefined });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveEdtVm: major из ini (25), а не жёсткий 17', () => {
  const dir = tempDir();
  try {
    const components = join(dir, 'components');
    const home = join(components, '1c-edt-2026.2.2+21-x86_64');
    touch(join(home, '1cedt.exe'));
    const jdk17 = join(components, 'axiom-jdk-full-17.0.16+12-x86_64', 'bin');
    const jdk25 = join(components, 'axiom-jdk-full-25.0.4+5-x86_64', 'bin');
    touch(join(jdk17, 'javaw.exe'));
    touch(join(jdk25, 'javaw.exe'));
    writeFileSync(join(home, '1cedt.ini'), '-vmargs\n-Dosgi.requiredJavaVersion=25\n', 'utf8');

    assert.equal(resolveEdtVm(normalizeWorkspaceSettings({}), home, { platform: 'win32', env: {} }), join(jdk25, 'javaw.exe'));

    writeFileSync(join(home, '1cedt.ini'), '-vmargs\n-Dosgi.requiredJavaVersion=21\n', 'utf8');
    assert.equal(resolveEdtVm(normalizeWorkspaceSettings({}), home, { platform: 'win32', env: {} }), join(jdk25, 'javaw.exe'));

    writeFileSync(join(home, '1cedt.ini'), '-vmargs\n', 'utf8');
    assert.equal(resolveEdtVm(normalizeWorkspaceSettings({}), home, { platform: 'win32', env: {} }), join(jdk25, 'javaw.exe'));

    assert.equal(
      resolveEdtVm(normalizeWorkspaceSettings({ vm: 'C:/explicit/java' }), home, { platform: 'win32', env: {} }),
      'C:/explicit/java',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcpEvidence находит бандл в пользовательской configuration area', () => {
  const dir = tempDir();
  try {
    const home = join(dir, '1c-edt-2026.2.2+21-x86_64');
    touch(join(home, '1cedt.exe'));
    const eclipseRoot = join(dir, '.eclipse');
    const area = join(eclipseRoot, 'org.eclipse.platform_4.38.0_1');
    const bundles = join(area, 'configuration', 'org.eclipse.equinox.simpleconfigurator', 'bundles.info');
    touch(bundles, 'com.ditrix.edt.mcp.server,2.23.1,../../plugins/com.ditrix.edt.mcp.server_2.23.1.jar,4,false\n');

    const evidence = mcpEvidence(home, { platform: 'win32', eclipseRoots: [eclipseRoot] });
    assert.equal(evidence.found, true);
    assert.ok(evidence.evidence.some((line) => line.endsWith('bundles.info')));

    touch(join(home, 'plugins', 'com.ditrix.edt.mcp.server_1.27.0', 'plugin.xml'));
    assert.equal(hasMcpBundle(home, { platform: 'win32', eclipseRoots: [] }), true, 'бандл в установке');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writePrefs: plain text, HTTP и включение get_form_screenshot', () => {
  const dir = tempDir();
  try {
    const buildDir = join(dir, 'build');
    writePrefs(buildDir, 24589);
    let text = readFileSync(prefsPath(buildDir), 'utf8');
    assert.match(text, /mcpServerHttpEnabled=true/);
    assert.match(text, /mcpPlainTextMode=true/);
    assert.match(text, /mcpDisabledTools=git,ask_workmate\n/, 'get_form_screenshot включён');

    writeFileSync(
      prefsPath(buildDir),
      'eclipse.preferences.version=1\nmcpDisabledTools=git,ask_workmate,get_form_screenshot,custom\nmcpToolPrefsMigration=22\n',
      'utf8',
    );
    writePrefs(buildDir, 24590);
    text = readFileSync(prefsPath(buildDir), 'utf8');
    assert.match(text, /mcpDisabledTools=git,ask_workmate,custom\n/, 'чужие инструменты сохранены');
    assert.match(text, /mcpToolPrefsMigration=22\n/);

    writePrefs(buildDir, 24591, { plainText: false, formScreenshots: false });
    text = readFileSync(prefsPath(buildDir), 'utf8');
    assert.match(text, /mcpPlainTextMode=false/);
    assert.match(text, /mcpDisabledTools=git,ask_workmate,custom,get_form_screenshot\n/, 'при выключенных скриншотах инструмент снова отключён');

    const args = guiArgs({ wsDir: 'ws', xmx: '6g', nativeFormBufferedLayoutRender: true });
    assert.deepEqual(args.slice(-3), ['-vmargs', '-Xmx6g', '-DnativeFormBufferedLayoutRender=true']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseImportProgress: счётчик и текущий проект, ограничение total', () => {
  const text = [
    '!MESSAGE Project context is being started: cf (EXISTING_DATA_IMPORT)',
    '!MESSAGE Project context is started: cf',
    '!MESSAGE Project context is being started: epf_One (EXISTING_DATA_IMPORT)',
    '!MESSAGE Project context is started: epf_One',
    '!MESSAGE Project context is being started: epf_Two (EXISTING_DATA_IMPORT)',
  ].join('\n');
  const progress = parseImportProgress(text, 19);
  assert.equal(progress.startedCount, 2);
  assert.equal(progress.total, 19);
  assert.equal(progress.current, 'epf_Two');
  assert.deepEqual(progress.started, ['cf', 'epf_One']);
  assert.equal(parseImportProgress(text, 1).startedCount, 1, 'не больше total');
});

test('readFromOffset и importDigest читают только новые строки metadata-лога', () => {
  const dir = tempDir();
  try {
    const buildDir = join(dir, 'build');
    const log = join(buildDir, 'ws', '.metadata', '.log');
    touch(log, 'old line\n');
    const first = readFromOffset(log, 0);
    assert.match(first.text, /old line/);
    assert.equal(first.offset, statSync(log).size);

    writeFileSync(log, `${readFileSync(log, 'utf8')}!MESSAGE Project context is started: cf\n`, 'utf8');
    const digest = importDigest(buildDir, first.offset, 19);
    assert.equal(digest.startedCount, 1);
    assert.equal(digest.current, 'cf');
    assert.ok(digest.lines.some((line) => line.includes('Project context is started')));
    assert.equal(readFromOffset(log, digest.offset).text, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importMemoryWarning: предупреждает при ≥85 % и CPU overload', () => {
  assert.deepEqual(importMemoryWarning('лимит не достигнут'), undefined);
  const warning = importMemoryWarning('CPU overload. Memory 7195 MB used of 8192 MB');
  assert.equal(warning.used, 7195);
  assert.equal(warning.total, 8192);
  assert.ok(warning.ratio > 0.85);
  assert.equal(importMemoryWarning('Memory 100 MB used of 8192 MB'), undefined);
  assert.equal(importMemoryWarning('CPU overload without numbers').cpuOverload, true);
});

test('файлы состояния лежат в build и переживают повторное чтение', () => {
  const buildDir = join(tempDir(), 'build');
  try {
    writePort(buildDir, 30001);
    writeStamp(buildDir, 'ready');
    assert.equal(readPort(buildDir), 30001);
    assert.equal(existsSync(filePath(buildDir, 'ready')), true);
    writeFileSync(filePath(buildDir, 'port'), 'broken', 'utf8');
    assert.equal(readPort(buildDir), null);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
});
