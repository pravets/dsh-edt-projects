// Провайдер навыков, поставляемых вместе с бандлом.
//
// Навыки лежат в plugin/skills/<name>/SKILL.md и попадают в каталог только
// когда включены в конфиге проекта: list() возвращает лишь те, для которых
// сработал предикат. Это и есть «включается по конфигу».
//
// Включение трёхзначное: ключ `enabled` не задан — навык включается по маркеру
// репозитория, `true` — принудительно включён, `false` — принудительно выключен.
// Маркеры читаются по файлам, без вызова git: `.gitlab-ci.yml` для GitLab и
// `sonar-project.properties` для Sonar.
//
// Ранг 600 — стандартный BUNDLED_SKILL_RANK из @deepseek-ai/dsh-skill:
// проектные .agents/skills имеют приоритет выше и переопределяют встроенные.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repositoriesUnder, repositoryAt } from './repo.mjs';

const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));

/** Ранг packaged-навыков (BUNDLED_SKILL_RANK в dsh-skill). */
export const BUNDLED_RANK = 600;

const INVOCATION = { modelInvocable: true, userInvocable: true };

/** Файлы репозитория, по которым видно, что проект живёт в GitLab. */
export const GITLAB_MARKERS = ['.gitlab-ci.yml', '.gitlab/merge_request_templates'];

/** Файлы репозитория, по которым видно, что проект проверяется в SonarQube. */
export const SONAR_MARKERS = ['sonar-project.properties'];

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Каталоги, где искать маркер: сам каталог сессии, корень его репозитория
 * (и основной checkout worktree), плюс репозитории первого уровня task space.
 * @returns {string[]}
 */
function markerDirs(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return [];
  const dirs = [cwd];
  const direct = repositoryAt(cwd);
  if (direct !== undefined) dirs.push(direct.root, direct.mainRoot);
  for (const repo of repositoriesUnder(cwd)) dirs.push(repo.root, repo.mainRoot);

  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * Первый найденный маркер из списка (для диагностики возвращается его имя).
 * @returns {string|undefined}
 */
export function findMarker(cwd, markers) {
  for (const dir of markerDirs(cwd)) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return marker;
    }
  }
  return undefined;
}

/**
 * Состояние навыка: включён ли и почему.
 * reason: `flag` | `marker:<путь>` | `projectKey` | `server` | `off` | `no-marker`.
 * @returns {{ enabled: boolean, reason: string }}
 */
export function skillState(name, config, cwd) {
  if (name === 'edt-mcp-project-gitlab') {
    const flag = config?.gitlab?.enabled;
    if (flag === false) return { enabled: false, reason: 'off' };
    if (flag === true) return { enabled: true, reason: 'flag' };
    const marker = findMarker(cwd, GITLAB_MARKERS);
    return marker === undefined
      ? { enabled: false, reason: 'no-marker' }
      : { enabled: true, reason: `marker:${marker}` };
  }

  if (name === 'edt-mcp-project-sonar') {
    const flag = config?.sonar?.enabled;
    if (flag === false) return { enabled: false, reason: 'off' };
    if (flag === true) return { enabled: true, reason: 'flag' };
    if (nonEmpty(config?.sonar?.projectKey)) return { enabled: true, reason: 'projectKey' };
    const marker = findMarker(cwd, SONAR_MARKERS);
    if (marker !== undefined) return { enabled: true, reason: `marker:${marker}` };
    const server = config?.servers?.sonarqube;
    if (server !== undefined && server !== null && server.disabled !== true) {
      return { enabled: true, reason: 'server' };
    }
    return { enabled: false, reason: 'no-marker' };
  }

  return { enabled: false, reason: 'no-marker' };
}

/** GitLab-навык: флаг сильнее маркеров, отсутствие ключа — авто по маркерам. */
export function isGitlabEnabled(config, cwd) {
  return skillState('edt-mcp-project-gitlab', config, cwd).enabled;
}

/** Sonar-навык: флаг сильнее, затем ключ проекта, маркер и настроенный сервер. */
export function isSonarEnabled(config, cwd) {
  return skillState('edt-mcp-project-sonar', config, cwd).enabled;
}

/** Навыки пакета и предикаты их включения. */
export const SKILLS = [
  { name: 'edt-mcp-project-sonar', enabled: isSonarEnabled },
  { name: 'edt-mcp-project-gitlab', enabled: isGitlabEnabled },
];

/** Состояния всех навыков пакета — для `edt_config show`. */
export function skillStates(config, cwd) {
  return SKILLS.map((skill) => ({ name: skill.name, ...skillState(skill.name, config, cwd) }));
}

/**
 * Разбирает YAML-frontmatter простого вида (name/description одной строкой).
 * @returns {{ meta: Record<string, string>, body: string }}
 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text };

  const meta = {};
  for (const line of text.slice(3, end).split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (value !== '') meta[match[1]] = value;
  }
  const body = text.slice(end + 4).replace(/^\n+/, '');
  return { meta, body };
}

/** Путь к файлу навыка. */
export function skillFile(name) {
  return join(SKILLS_ROOT, name, 'SKILL.md');
}

/**
 * Создаёт провайдер навыков.
 * @param options.resolveConfig вызывается с cwd и возвращает действующий конфиг.
 * @param options.isEnabled вызывается с (cwd, config) и говорит, активирован ли
 *   плагин для этого проекта; для выключенного проекта навыков нет.
 * @param options.logger необязательный логгер для предупреждений.
 */
export function createSkillsProvider({ resolveConfig, isEnabled, logger } = {}) {
  const read = (name) => {
    const path = skillFile(name);
    if (!existsSync(path)) return undefined;
    return { path, ...parseFrontmatter(readFileSync(path, 'utf8')) };
  };

  const configFor = (cwd) => (typeof resolveConfig === 'function' ? resolveConfig(cwd) : {}) ?? {};

  const allowed = (cwd) => {
    if (typeof isEnabled !== 'function') return true;
    return isEnabled(cwd, configFor(cwd)) === true;
  };

  const toCandidate = (name) => {
    const parsed = read(name);
    if (parsed === undefined || parsed.meta.description === undefined) return undefined;
    return {
      name,
      description: parsed.meta.description,
      invocation: INVOCATION,
      provider: 'edt-mcp-bundle-skills',
      source: 'bundled',
      rank: BUNDLED_RANK,
      resourceBase: { kind: 'directory', path: dirname(parsed.path) },
      locator: parsed.path,
    };
  };

  return {
    name: 'edt-mcp-bundle-skills',
    /** Отдаёт только навыки, включённые в конфиге проекта. */
    list(options = {}) {
      const cwd = options.cwd ?? process.cwd();
      if (!allowed(cwd)) return [];
      const config = configFor(cwd);
      const candidates = [];
      for (const skill of SKILLS) {
        if (skill.enabled(config, cwd) !== true) continue;
        const candidate = toCandidate(skill.name);
        if (candidate === undefined) {
          logger?.warn?.(`skills: ${skill.name} включён в конфиге, но файл навыка не найден`);
          continue;
        }
        candidates.push(candidate);
      }
      return candidates;
    },
    /** Возвращает тело навыка без frontmatter. */
    get(candidate, options = {}) {
      const cwd = options.cwd ?? process.cwd();
      if (!allowed(cwd)) return undefined;
      const config = configFor(cwd);
      const skill = SKILLS.find((entry) => entry.name === candidate?.name);
      if (skill === undefined || skill.enabled(config, cwd) !== true) return undefined;
      const parsed = read(candidate?.name);
      if (parsed === undefined) return undefined;
      return {
        name: candidate.name,
        description: parsed.meta.description,
        invocation: INVOCATION,
        provider: 'edt-mcp-bundle-skills',
        source: 'bundled',
        resourceBase: { kind: 'directory', path: dirname(parsed.path) },
        content: parsed.body,
      };
    },
  };
}
