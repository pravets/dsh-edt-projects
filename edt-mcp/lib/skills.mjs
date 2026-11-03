// Провайдер навыков, поставляемых вместе с бандлом.
//
// Навыки лежат в edt-mcp/skills/<name>/SKILL.md и попадают в каталог только
// когда включены в конфиге проекта: list() возвращает лишь те, для которых
// сработал предикат. Это и есть «включается по конфигу».
//
// Ранг 600 — стандартный BUNDLED_SKILL_RANK из @deepseek-ai/dsh-skill:
// проектные .agents/skills имеют приоритет выше и переопределяют встроенные.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));

/** Ранг packaged-навыков (BUNDLED_SKILL_RANK в dsh-skill). */
export const BUNDLED_RANK = 600;

const INVOCATION = { modelInvocable: true, userInvocable: true };

/** Sonar включён явным флагом или наличием MCP-сервера sonarqube. */
export function isSonarEnabled(config) {
  if (config?.sonar?.enabled === true) return true;
  const server = config?.servers?.sonarqube;
  return server !== undefined && server !== null && server.disabled !== true;
}

/** GitLab включается только явным флагом. */
export function isGitlabEnabled(config) {
  return config?.gitlab?.enabled === true;
}

/** Навыки пакета и предикаты их включения. */
export const SKILLS = [
  { name: 'edt-mcp-project-sonar', enabled: isSonarEnabled },
  { name: 'edt-mcp-project-gitlab', enabled: isGitlabEnabled },
];

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
 * @param options.logger необязательный логгер для предупреждений.
 */
export function createSkillsProvider({ resolveConfig, logger } = {}) {
  const read = (name) => {
    const path = skillFile(name);
    if (!existsSync(path)) return undefined;
    return { path, ...parseFrontmatter(readFileSync(path, 'utf8')) };
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
      const config = typeof resolveConfig === 'function' ? resolveConfig(options.cwd) : {};
      const candidates = [];
      for (const skill of SKILLS) {
        if (!skill.enabled(config)) continue;
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
    get(candidate) {
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
