// Тесты провайдера навыков: включение по конфигу, разбор frontmatter,
// содержимое файлов и отсутствие зашитых адресов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLED_RANK,
  SKILLS,
  createSkillsProvider,
  isGitlabEnabled,
  isSonarEnabled,
  parseFrontmatter,
  skillFile,
} from '../edt-mcp/lib/skills.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const skillsRoot = join(here, '..', 'edt-mcp', 'skills');

const providerWith = (config) => createSkillsProvider({ resolveConfig: () => config });
const names = (config) => providerWith(config).list({}).map((skill) => skill.name);

test('без флагов каталог навыков пуст', () => {
  assert.deepEqual(names({}), []);
  assert.deepEqual(names(undefined), []);
});

test('sonar включается флагом и наличием сервера sonarqube', () => {
  assert.deepEqual(names({ sonar: { enabled: true } }), ['edt-mcp-project-sonar']);
  assert.deepEqual(names({ servers: { sonarqube: { url: 'http://127.0.0.1:9000/mcp' } } }), ['edt-mcp-project-sonar']);
  assert.deepEqual(names({ servers: { sonarqube: { url: 'x', disabled: true } } }), []);
});

test('gitlab включается только явным флагом', () => {
  assert.deepEqual(names({ gitlab: { enabled: true } }), ['edt-mcp-project-gitlab']);
  assert.deepEqual(names({ gitlab: { enabled: false } }), []);
});

test('оба флага дают оба навыка', () => {
  assert.deepEqual(names({ sonar: { enabled: true }, gitlab: { enabled: true } }).sort(), [
    'edt-mcp-project-gitlab',
    'edt-mcp-project-sonar',
  ]);
});

test('предикаты включения экспортированы и работают', () => {
  assert.equal(isSonarEnabled({ sonar: { enabled: true } }), true);
  assert.equal(isSonarEnabled({}), false);
  assert.equal(isGitlabEnabled({ gitlab: { enabled: true } }), true);
  assert.equal(isGitlabEnabled({}), false);
});

test('кандидат содержит обязательные поля', () => {
  const [candidate] = providerWith({ gitlab: { enabled: true } }).list({});
  assert.equal(candidate.name, 'edt-mcp-project-gitlab');
  assert.equal(candidate.source, 'bundled');
  assert.equal(candidate.rank, BUNDLED_RANK);
  assert.equal(candidate.provider, 'edt-mcp-bundle-skills');
  assert.equal(candidate.invocation.modelInvocable, true);
  assert.equal(candidate.resourceBase.kind, 'directory');
  assert.equal(existsSync(candidate.resourceBase.path), true);
  assert.ok(candidate.description.length > 20);
});

test('get отдаёт тело без frontmatter', () => {
  const provider = providerWith({ sonar: { enabled: true } });
  const [candidate] = provider.list({});
  const skill = provider.get(candidate);
  assert.equal(skill.name, 'edt-mcp-project-sonar');
  assert.equal(skill.content.startsWith('---'), false);
  assert.match(skill.content, /# EDT-MCP SonarQube/);
  assert.equal(skill.source, 'bundled');
});

test('parseFrontmatter: значения, кавычки и отсутствие блока', () => {
  const parsed = parseFrontmatter('---\nname: demo\ndescription: "A demo skill"\n---\n\n# Body\n');
  assert.deepEqual(parsed.meta, { name: 'demo', description: 'A demo skill' });
  assert.equal(parsed.body.startsWith('# Body'), true);

  const plain = parseFrontmatter('# Just a body\n');
  assert.deepEqual(plain.meta, {});
  assert.equal(plain.body, '# Just a body\n');
});

test('файлы навыков: имя совпадает с каталогом, kebab-case, описание есть', () => {
  for (const skill of SKILLS) {
    const file = skillFile(skill.name);
    assert.equal(existsSync(file), true, `${file} должен существовать`);
    const { meta } = parseFrontmatter(readFileSync(file, 'utf8'));
    assert.equal(meta.name, skill.name);
    assert.ok(meta.description !== undefined && meta.description.length > 20);
    assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
});

test('в текстах навыков нет реальных адресов и ключей проектов', () => {
  const forbidden = [/[a-z0-9-]+\.internal\b/i, /\bgitlab\.[a-z0-9-]+\.[a-z]{2,}\b/i, /\bsq\.[a-z0-9-]+\.[a-z]{2,}\b/i];
  for (const file of walk(skillsRoot)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${file} содержит зашитый адрес: ${pattern}`);
    }
  }
});

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
