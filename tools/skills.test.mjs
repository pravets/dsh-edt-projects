// Тесты провайдера навыков: включение по флагу и по маркерам репозитория,
// разбор frontmatter, содержимое файлов и отсутствие зашитых адресов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLED_RANK,
  GITLAB_MARKERS,
  SKILLS,
  SONAR_MARKERS,
  createSkillsProvider,
  findMarker,
  isGitlabEnabled,
  isSonarEnabled,
  parseFrontmatter,
  skillFile,
  skillState,
  skillStates,
} from '../packages/dsh-edt-projects/lib/skills.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const skillsRoot = join(here, '..', 'packages', 'dsh-edt-projects', 'skills');

const providerWith = (config) => createSkillsProvider({ resolveConfig: () => config });

/** Каталог без маркеров: временный, вне рабочего репозитория. */
const emptyDir = () => mkdtempSync(join(tmpdir(), 'dsh-skills-empty-'));
const markerDir = (marker) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skills-marker-'));
  const file = join(dir, marker);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '', 'utf8');
  return dir;
};

const names = (config, cwd = emptyDir()) => providerWith(config).list({ cwd }).map((skill) => skill.name);

test('без флагов и маркеров каталог навыков пуст', () => {
  assert.deepEqual(names({}), []);
  assert.deepEqual(names(undefined), []);
});

test('sonar включается флагом и наличием сервера sonarqube', () => {
  assert.deepEqual(names({ sonar: { enabled: true } }), ['edt-mcp-project-sonar']);
  assert.deepEqual(names({ servers: { sonarqube: { url: 'http://127.0.0.1:9000/mcp' } } }), ['edt-mcp-project-sonar']);
  assert.deepEqual(names({ servers: { sonarqube: { url: 'x', disabled: true } } }), []);
});

test('gitlab включается только флагом, когда маркеров нет', () => {
  assert.deepEqual(names({ gitlab: { enabled: true } }), ['edt-mcp-project-gitlab']);
  assert.deepEqual(names({ gitlab: { enabled: false } }), []);
});

test('оба флага дают оба навыка', () => {
  assert.deepEqual(names({ sonar: { enabled: true }, gitlab: { enabled: true } }).sort(), [
    'edt-mcp-project-gitlab',
    'edt-mcp-project-sonar',
  ]);
});

test('gitlab включается маркером .gitlab-ci.yml без флага', () => {
  const cwd = markerDir(GITLAB_MARKERS[0]);
  assert.deepEqual(names({}, cwd), ['edt-mcp-project-gitlab']);
  assert.deepEqual(skillState('edt-mcp-project-gitlab', {}, cwd), {
    enabled: true,
    reason: `marker:${GITLAB_MARKERS[0]}`,
  });
});

test('gitlab включается каталогом шаблонов merge request', () => {
  const cwd = markerDir('.gitlab/merge_request_templates/default.md');
  assert.equal(isGitlabEnabled({}, cwd), true);
  assert.equal(findMarker(cwd, GITLAB_MARKERS), '.gitlab/merge_request_templates');
});

test('sonar включается маркером sonar-project.properties', () => {
  const cwd = markerDir(SONAR_MARKERS[0]);
  assert.deepEqual(names({}, cwd), ['edt-mcp-project-sonar']);
  assert.equal(skillState('edt-mcp-project-sonar', {}, cwd).reason, `marker:${SONAR_MARKERS[0]}`);
});

test('явный false сильнее маркера, явный true не требует маркера', () => {
  const cwd = markerDir(GITLAB_MARKERS[0]);
  assert.deepEqual(names({ gitlab: { enabled: false } }, cwd), []);
  assert.equal(skillState('edt-mcp-project-gitlab', { gitlab: { enabled: false } }, cwd).reason, 'off');

  const plain = emptyDir();
  assert.deepEqual(names({ gitlab: { enabled: true } }, plain), ['edt-mcp-project-gitlab']);
  assert.equal(skillState('edt-mcp-project-gitlab', { gitlab: { enabled: true } }, plain).reason, 'flag');
});

test('sonar: projectKey включает навык, явный false выключает даже при сервере', () => {
  const cwd = emptyDir();
  assert.equal(isSonarEnabled({ sonar: { projectKey: 'demo' } }, cwd), true);
  assert.equal(skillState('edt-mcp-project-sonar', { sonar: { projectKey: 'demo' } }, cwd).reason, 'projectKey');
  assert.equal(
    isSonarEnabled({ sonar: { enabled: false }, servers: { sonarqube: { url: 'http://x' } } }, cwd),
    false,
  );
});

test('маркер находится из подкаталога репозитория', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skills-repo-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, GITLAB_MARKERS[0]), '', 'utf8');
  const sub = join(root, 'src', 'nested');
  mkdirSync(sub, { recursive: true });

  assert.equal(isGitlabEnabled({}, sub), true);
  assert.equal(skillState('edt-mcp-project-gitlab', {}, sub).reason, `marker:${GITLAB_MARKERS[0]}`);
});

test('маркер находится в репозитории task space', () => {
  const task = mkdtempSync(join(tmpdir(), 'dsh-skills-task-'));
  const repo = join(task, 'repo-a');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, SONAR_MARKERS[0]), '', 'utf8');

  assert.equal(isSonarEnabled({}, task), true);
  assert.equal(skillState('edt-mcp-project-sonar', {}, task).reason, `marker:${SONAR_MARKERS[0]}`);
});

test('без cwd маркеры не читаются, флаги работают', () => {
  assert.equal(isGitlabEnabled({}), false);
  assert.equal(isGitlabEnabled({ gitlab: { enabled: true } }), true);
  assert.equal(isSonarEnabled({}), false);
});

test('skillStates перечисляет оба навыка с причиной', () => {
  const cwd = markerDir(GITLAB_MARKERS[0]);
  const states = skillStates({ sonar: { enabled: true } }, cwd);
  assert.deepEqual(
    states.map((state) => [state.name, state.enabled, state.reason]),
    [
      ['edt-mcp-project-sonar', true, 'flag'],
      ['edt-mcp-project-gitlab', true, `marker:${GITLAB_MARKERS[0]}`],
    ],
  );
});

test('предикаты включения экспортированы и работают', () => {
  const cwd = emptyDir();
  assert.equal(isSonarEnabled({ sonar: { enabled: true } }, cwd), true);
  assert.equal(isSonarEnabled({}, cwd), false);
  assert.equal(isGitlabEnabled({ gitlab: { enabled: true } }, cwd), true);
  assert.equal(isGitlabEnabled({}, cwd), false);
});

test('кандидат содержит обязательные поля', () => {
  const [candidate] = providerWith({ gitlab: { enabled: true } }).list({ cwd: emptyDir() });
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
  const [candidate] = provider.list({ cwd: emptyDir() });
  const skill = provider.get(candidate);
  assert.equal(skill.name, 'edt-mcp-project-sonar');
  assert.equal(skill.content.startsWith('---'), false);
  assert.match(skill.content, /# SonarQube/);
  assert.equal(skill.source, 'bundled');
});

test('get не отдаёт навык, выключенный явным false', () => {
  const cwd = markerDir(GITLAB_MARKERS[0]);
  const provider = providerWith({ gitlab: { enabled: false } });
  assert.equal(provider.get({ name: 'edt-mcp-project-gitlab' }, { cwd }), undefined);
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

test('навык GitLab: оформление MR, замечания ревью и запрет мержа без запроса', () => {
  const text = readFileSync(skillFile('edt-mcp-project-gitlab'), 'utf8');
  for (const fragment of [
    '--template',
    '--state unresolved',
    'discussions',
    '--reply',
    'note resolve',
    '--auto-merge',
    'Merge request body',
  ]) {
    assert.ok(text.includes(fragment), `в навыке нет «${fragment}»`);
  }
  assert.match(text, /Merge is forbidden without an explicit request/);
  assert.match(text, /Never merge a merge request without an explicit user request/);
});

test('навык Sonar: замечания, компактный вывод и гейт', () => {
  const text = readFileSync(skillFile('edt-mcp-project-sonar'), 'utf8');
  for (const fragment of ['--statuses', '--format toon', 'sonar list projects', 'qualitygates/project_status']) {
    assert.ok(text.includes(fragment), `в навыке нет «${fragment}»`);
  }
  assert.match(text, /not Sonar issues|не Sonar-issues|Merge request remarks are not Sonar issues/);
});

test('выключенный проект: навыков нет даже при включённых флагах', () => {
  const provider = createSkillsProvider({
    resolveConfig: () => ({ sonar: { enabled: true }, gitlab: { enabled: true } }),
    isEnabled: () => false,
  });
  assert.deepEqual(provider.list({ cwd: 'C:\\git\\other' }), []);
  assert.equal(provider.get({ name: 'edt-mcp-project-sonar' }, { cwd: 'C:\\git\\other' }), undefined);
});

test('isEnabled получает cwd и действующий конфиг', () => {
  const seen = [];
  const provider = createSkillsProvider({
    resolveConfig: () => ({ gitlab: { enabled: true } }),
    isEnabled: (cwd, config) => {
      seen.push([cwd, config.gitlab.enabled]);
      return cwd === '/enabled';
    },
  });
  assert.deepEqual(provider.list({ cwd: '/enabled' }).map((skill) => skill.name), ['edt-mcp-project-gitlab']);
  assert.deepEqual(provider.list({ cwd: '/disabled' }), []);
  assert.deepEqual(seen, [
    ['/enabled', true],
    ['/disabled', true],
  ]);
});

test('в текстах навыков нет зашитых адресов и ключей проектов', () => {
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
