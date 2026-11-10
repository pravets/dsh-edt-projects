#!/usr/bin/env node
// CLI окружения EDT worktree — то же, что делает плагин, но для терминала.
//
//   node tools/edt-workspace.mjs status --root C:\git\worktree-space\trade\task
//   node tools/edt-workspace.mjs init   --root <worktree>
//   node tools/edt-workspace.mjs stop   --root <worktree>
//   node tools/edt-workspace.mjs stop-all --repo C:\git\trade
//
// Для подъёма нужен build/workspace.json: его пишет плагин при первой сессии.
// Без него init возьмёт настройки по умолчанию (все проекты с .project).
import { main } from '../packages/dsh-edt-projects/lib/workspace-run.mjs';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`edt-workspace: ${error?.message ?? error}`);
  process.exitCode = 1;
}
