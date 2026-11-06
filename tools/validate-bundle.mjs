// Проверка целостности бандла: манифест, патч композиции, локали, иконка.
// Ничего не устанавливает и не трогает профиль DSH — только читает файлы.
//
// Запуск:
//   node tools/validate-bundle.mjs            обычная проверка
//   node tools/validate-bundle.mjs --tag v0.9.0   дополнительно сверить версию с тегом
//
// Код возврата: 0 — замечаний нет, 1 — есть.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { DEFAULTS } from '../edt-mcp/lib/schema.mjs';

// `yaml` подключается как CommonJS, поэтому берём его default-экспорт.
const { parse: parseYaml } = YAML;

// Патч использует тег `!!js` (выражение загрузчика DSH), а в yaml 2.9 нет
// публичного конструктора кастомного тега. Поэтому до разбора подменяем
// `!!js 'выражение'` на обычный объект {js: "выражение"}.
const JS_TAG = /!!js\s+'((?:[^'\\]|\\.)*)'/g;
const isExpression = (value) => typeof value === 'object' && value !== null && typeof value.js === 'string';
const parsePatch = (text) => parseYaml(text.replace(JS_TAG, (_, expr) => JSON.stringify({ js: expr })));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = join(root, 'edt-mcp');

const problems = [];
const ok = [];
const fail = (message) => problems.push(message);
const pass = (message) => ok.push(message);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${file}: не разбирается как JSON — ${err.message}`);
    return null;
  }
}

// Разворачивает запись из "files" (поддерживает простой "*" в имени файла).
function expand(pattern) {
  if (!pattern.includes('*')) return existsSync(join(bundleDir, pattern)) ? [pattern] : [];
  const slash = pattern.lastIndexOf('/');
  const dir = slash === -1 ? '' : pattern.slice(0, slash);
  const mask = pattern.slice(slash + 1);
  const re = new RegExp(`^${mask.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  let entries;
  try {
    entries = readdirSync(join(bundleDir, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && re.test(e.name)).map((e) => (dir ? `${dir}/${e.name}` : e.name));
}

// --- манифест бандла -------------------------------------------------------
const manifestPath = join(bundleDir, 'package.json');
const manifest = readJson(manifestPath);
let patchPath = null;

if (manifest) {
  if (!manifest.name) fail('package.json: не задано name');
  if (!manifest.version) fail('package.json: не задано version');
  else if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version)) fail(`package.json: ожидался SemVer вида 0.9.0, получено ${manifest.version}`);
  else pass(`версия ${manifest.version}`);

  const declared = manifest.dsh?.bundle?.patch;
  if (!declared) {
    fail('package.json: нет dsh.bundle.patch — менеджер плагинов не увидит бандл');
  } else {
    patchPath = join(bundleDir, declared);
    if (!existsSync(patchPath)) fail(`package.json: dsh.bundle.patch указывает на ${declared}, файла нет`);
    else pass(`патч ${declared}`);
  }

  // Код бандла (правила для модели) должен существовать: строка mcp-rules
  // в патче ссылается на сам пакет.
  const entry = manifest.main ?? (typeof manifest.exports?.['.'] === 'string' ? manifest.exports['.'] : null);
  if (!entry) fail('package.json: нет main/exports["."] — строке mcp-rules нечего загружать');
  else if (!existsSync(join(bundleDir, entry))) fail(`package.json: точка входа ${entry} не существует`);
  else pass(`точка входа ${entry}`);

  for (const entryPath of manifest.files ?? []) {
    const found = expand(entryPath);
    if (found.length === 0) fail(`package.json: files "${entryPath}" не соответствует ни одному файлу`);
  }
  const listed = (manifest.files ?? []).flatMap(expand);
  if (listed.length > 0) pass(`files: ${listed.length} шт.`);

  // Всё, что объявлено в files, должно попасть в tarball; экспорт иконки/локалей — тоже.
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    const target = String(value).replace('./', '');
    const found = expand(target);
    if (found.length === 0) fail(`package.json: exports["${key}"] указывает на ${value}, файлов нет`);
  }

  // Версия объявлена в четырёх местах: корень, бандл и два поля lock.
  // Забытое при бампе место — самая частая ошибка, поэтому сверяем явно.
  const rootManifest = readJson(join(root, 'package.json'));
  const lock = readJson(join(root, 'package-lock.json'));
  const versionSources = [
    ['package.json', rootManifest?.version],
    ['package-lock.json:version', lock?.version],
    ['package-lock.json:packages[""]', lock?.packages?.['']?.version],
    ['package-lock.json:packages["edt-mcp"]', lock?.packages?.['edt-mcp']?.version],
  ].filter(([, version]) => version !== undefined);
  const mismatched = versionSources.filter(([, version]) => version !== manifest.version);
  if (mismatched.length > 0) {
    fail(`версии расходятся: бандл ${manifest.version}, ${mismatched.map(([where, version]) => `${where} ${version}`).join(', ')}`);
  } else {
    pass(`версии согласованы: ${versionSources.map(([where]) => where).join(', ')} — ${manifest.version}`);
  }

  // npm отклоняет приватный пакет, а без README/LICENSE публикация выходит неполной.
  if (manifest.private === true) fail('package.json: "private": true — такой пакет npm publish отклонит');
  else pass('пакет публикуемый (private не задан)');
  if (manifest.license === undefined) fail('package.json: нет license — пакет уйдёт в npm без лицензии');
  else pass(`лицензия ${manifest.license}`);
  const missingDocs = ['README.md', 'LICENSE'].filter((file) => !existsSync(join(bundleDir, file)));
  if (missingDocs.length > 0) fail(`в каталоге бандла нет ${missingDocs.join(', ')} — npm не включит их в пакет`);
  else pass('README.md и LICENSE попадут в пакет');
}

// --- патч композиции -------------------------------------------------------
if (patchPath && existsSync(patchPath)) {
  let rows;
  try {
    rows = parsePatch(readFileSync(patchPath, 'utf8'));
  } catch (err) {
    fail(`cordis.patch.yml: не разбирается как YAML — ${err.message}`);
  }

  if (rows !== undefined) {
    if (!Array.isArray(rows) || rows.length === 0) fail('cordis.patch.yml: ожидался непустой список строк композиции');
    else {
      const inserted = [];
      rows.forEach((row, i) => {
        if (!row || typeof row !== 'object' || !Array.isArray(row.insert)) {
          fail(`cordis.patch.yml: строка ${i + 1} — ожидался объект с полем insert`);
          return;
        }
        row.insert.forEach((item) => inserted.push(item));
      });

      inserted.forEach((item, j) => {
        const at = `cordis.patch.yml: insert[${j}]`;
        if (!item || typeof item !== 'object') return fail(`${at} — не объект`);
        if (!item.id) fail(`${at} — нет id`);
        if (!item.name) return fail(`${at} — нет name (имя плагина)`);
        if (item.disabled !== undefined && item.disabled !== true && !isExpression(item.disabled)) {
          fail(`${at}: disabled должен быть true или !!js-выражением`);
        }
        const config = item.config;
        // Подробно проверяем только клиента MCP: у прочих плагинов своя схема.
        if (!String(item.name).includes('mcp-client')) return;
        if (config === undefined) return fail(`${at} — нет config`);
        if (typeof config !== 'object') return fail(`${at} — config не объект`);
        if (config.transport === 'stdio') {
          if (!config.command) fail(`${at}: transport=stdio требует command`);
        } else {
          if (!config.serverName) fail(`${at}: нет config.serverName — под ним появятся mcp__<serverName>__*`);
          if (!config.url) fail(`${at}: нет config.url`);
          else if (isExpression(config.url)) pass(`${at}: url задаётся выражением`);
          else {
            try {
              const url = new URL(config.url);
              if (!['http:', 'https:'].includes(url.protocol)) fail(`${at}: url ${config.url} — ожидался http(s)`);
            } catch {
              fail(`${at}: url ${config.url} не является URL`);
            }
          }
        }
      });

      if (inserted.length > 0) pass(`патч: ${inserted.length} вставка(и)`);

      // Строка самого бандла: у неё должен быть непустой список серверов.
      const hub = inserted.find((item) => item?.name === manifest?.name);
      if (!hub) {
        fail(`cordis.patch.yml: нет строки самого бандла (name: ${manifest?.name ?? '?'})`);
      } else {
        const servers = hub.config?.servers;
        if (!servers || typeof servers !== 'object' || Object.keys(servers).length === 0) {
          fail('cordis.patch.yml: у mcp-hub нет config.servers');
        } else {
          const names = Object.keys(servers);
          const lazy = names.filter((name) => servers[name]?.lazy === true);
          const eager = names.filter((name) => servers[name]?.lazy !== true && servers[name]?.unavailable === undefined);
          if (eager.length === 0) fail(`cordis.patch.yml: ни один сервер не подключается сразу (${names.join(', ')}) — в сессии не будет MCP-инструментов до mcp_pin`);
          else pass(`mcp-hub: ${names.length} сервер(а), сразу: ${eager.join(', ')}${lazy.length ? `, по требованию: ${lazy.join(', ')}` : ''}`);
        }
      }

      // Порт EDT: значение в патче и в DEFAULTS должно совпадать, иначе
      // `config upgrade` покажет один адрес, а хаб пойдёт на другой.
      const urlLine = /^\s*url:\s*(.+)$/m.exec(readFileSync(patchPath, 'utf8'))?.[1] ?? '';
      const patchPort = /:(\d+)\/mcp/.exec(urlLine)?.[1];
      const schemaPort = /:(\d+)\/mcp/.exec(DEFAULTS?.servers?.edt?.url ?? '')?.[1];
      if (patchPort === undefined || schemaPort === undefined) {
        fail('порт EDT не найден: ожидался http://127.0.0.1:<порт>/mcp в cordis.patch.yml и в DEFAULTS');
      } else if (patchPort !== schemaPort) {
        fail(`порт EDT расходится: cordis.patch.yml ${patchPort}, DEFAULTS ${schemaPort}`);
      } else {
        pass(`порт EDT по умолчанию ${patchPort}`);
      }

      // Два всегда включённых клиента с одним serverName уронили бы активацию.
      const always = inserted.filter((item) => item?.config?.serverName && item.disabled === undefined);
      const seen = new Map();
      for (const item of always) {
        const name = item.config.serverName;
        if (seen.has(name)) fail(`cordis.patch.yml: serverName "${name}" занят двумя строками без disabled`);
        seen.set(name, true);
      }
      if (seen.size === always.length) pass(`serverName уникальны среди всегда включённых строк (${seen.size})`);
    }
  }
}

// --- локали ----------------------------------------------------------------
const flatten = (value, prefix = '') =>
  Object.entries(value ?? {}).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, key) : [key];
  });

const locales = join(bundleDir, 'locale');
if (!existsSync(locales)) {
  fail('locale/: каталога нет');
} else {
  const langFiles = readdirSync(locales).filter((f) => f.endsWith('.json'));
  if (!langFiles.includes('en.json')) fail('locale/: нет en.json (базовый язык)');
  const sets = new Map();
  for (const file of langFiles) {
    const data = readJson(join(locales, file));
    if (data) sets.set(file, new Set(flatten(data)));
  }
  const base = sets.get('en.json');
  for (const [file, keys] of sets) {
    if (file === 'en.json' || !base) continue;
    const missing = [...base].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !base.has(k));
    if (missing.length) fail(`locale/${file}: нет ключей из en.json — ${missing.join(', ')}`);
    if (extra.length) fail(`locale/${file}: лишние ключи — ${extra.join(', ')}`);
    if (!missing.length && !extra.length) pass(`locale/${file}: ключи совпадают с en.json`);
  }
}

// --- навыки ----------------------------------------------------------------
// Навыки едут в пакете, поэтому проверяем и их, и запрет реальных адресов:
// в поставляемых текстах не должно быть конкретных хостов и ключей проектов.
const FORBIDDEN_TEXT = [
  { pattern: /[a-z0-9-]+\.internal\b/i, why: 'реальный внутренний хост' },
  { pattern: /\bgitlab\.[a-z0-9-]+\.[a-z]{2,}\b/i, why: 'реальный хост GitLab' },
  { pattern: /\bsq\.[a-z0-9-]+\.[a-z]{2,}\b/i, why: 'реальный хост Sonar' },
  { pattern: /\bprojectKey\s*=\s*(?!<)[a-z0-9_-]{3,}\b/i, why: 'конкретный ключ проекта Sonar' },
];

function scanForbidden(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const rule of FORBIDDEN_TEXT) {
      if (rule.pattern.test(line)) fail(`${file}:${index + 1}: ${rule.why} — ${line.trim().slice(0, 80)}`);
    }
  });
}

const skillsDir = join(bundleDir, 'skills');
if (!existsSync(skillsDir)) {
  fail('skills/: каталога нет');
} else {
  const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (dirs.length === 0) fail('skills/: нет ни одного навыка');
  for (const dir of dirs) {
    const file = join(skillsDir, dir.name, 'SKILL.md');
    if (!existsSync(file)) {
      fail(`skills/${dir.name}: нет SKILL.md`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (name === undefined) fail(`skills/${dir.name}/SKILL.md: нет name во frontmatter`);
    else if (name !== dir.name) fail(`skills/${dir.name}/SKILL.md: name «${name}» не совпадает с каталогом`);
    if (!/^description:\s*\S+/m.test(text)) fail(`skills/${dir.name}/SKILL.md: пустой description`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(dir.name)) fail(`skills/${dir.name}: имя не kebab-case`);
  }

  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  for (const file of walk(skillsDir)) scanForbidden(file);
  if (existsSync(join(root, 'README.md'))) scanForbidden(join(root, 'README.md'));

  const listed = (manifest?.files ?? []).some((entry) => entry === 'skills' || entry.startsWith('skills/'));
  if (!listed) fail('package.json: skills не указан в files — навыки не попадут в tarball');
  else pass(`skills: ${dirs.length} навык(а), адреса не зашиты`);
}

// --- иконка ----------------------------------------------------------------
const iconPath = join(bundleDir, 'icon.svg');
if (!existsSync(iconPath)) {
  fail('icon.svg: файла нет');
} else {
  const svg = readFileSync(iconPath, 'utf8');
  if (!svg.trimStart().startsWith('<svg')) fail('icon.svg: файл не начинается с <svg');
  if (!/viewBox\s*=/.test(svg)) fail('icon.svg: нет viewBox — иконка будет масштабироваться непредсказуемо');
  if (!svg.trimEnd().endsWith('</svg>')) fail('icon.svg: нет закрывающего </svg>');
  if (!problems.some((p) => p.startsWith('icon.svg'))) pass('icon.svg: корректна');
}

// --- сверка с тегом --------------------------------------------------------
const tagIndex = process.argv.indexOf('--tag');
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1];
  const expected = String(tag ?? '').replace(/^v/, '');
  if (!expected) fail('--tag: не передано значение');
  else if (manifest && expected !== manifest.version) fail(`тег ${tag} не совпадает с версией ${manifest.version}`);
  else pass(`тег ${tag} совпадает с версией`);
}

// --- отчёт -----------------------------------------------------------------
for (const line of ok) console.log(`  ok   ${line}`);
for (const line of problems) console.error(`  FAIL ${line}`);

if (problems.length) {
  console.error(`\nПроверка бандла: ${problems.length} замечание(й).`);
  process.exit(1);
}
console.log(`\nПроверка бандла: без замечаний (${ok.length} проверок).`);
