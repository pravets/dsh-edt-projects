// Флаги тестовой обвязки проекта: YAxUnit и Vanessa Automation.
//
// Настройка живёт в dsh-1c.json (проект/пользователь) и не детектируется по
// диску: наличие тестов — свойство проекта, а не догадка плагина.
//
//   "tests": {
//     "yaxunit": { "enabled": true, "path": "tests/yaxunit", "project": "cfe_yaxunit" },
//     "vanessa": { "enabled": true, "path": "features" }
//   }
//
// Допускается сокращение: "yaxunit": true (то же, что { "enabled": true }).

const TOOLS = ['yaxunit', 'vanessa'];

function normalizeOne(value) {
  if (value === true) return { enabled: true };
  if (value === false || value === undefined || value === null) return { enabled: false };
  if (typeof value !== 'object' || Array.isArray(value)) return { enabled: false };

  const result = { enabled: value.enabled === true };
  if (typeof value.path === 'string' && value.path !== '') result.path = value.path;
  if (typeof value.project === 'string' && value.project !== '') result.project = value.project;
  return result;
}

/**
 * Приводит секцию tests к предсказуемому виду.
 * @returns {{ yaxunit: { enabled: boolean, path?: string, project?: string },
 *             vanessa: { enabled: boolean, path?: string } }}
 */
export function normalizeTestTooling(tests) {
  const source = tests !== null && typeof tests === 'object' && !Array.isArray(tests) ? tests : {};
  const result = {};
  for (const tool of TOOLS) result[tool] = normalizeOne(source[tool]);
  return result;
}

/** Включён ли хотя бы один инструмент. */
export function hasTestTooling(tests) {
  const normalized = normalizeTestTooling(tests);
  return TOOLS.some((tool) => normalized[tool].enabled);
}
