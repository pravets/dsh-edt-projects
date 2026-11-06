---
name: edt-mcp-project-sonar
description: Inspect SonarQube issues and the quality gate for the current 1C project — «замечания Sonar», «гейт SonarQube», «почему падает sonarqube», SonarQube issues, quality gate status, failed sonarqube job. Works through Sonar MCP tools when they answer and through the local sonar CLI otherwise. Not for configuring the Sonar server or editing sonar-project.properties.
---

# EDT-MCP SonarQube

## Purpose and trigger

Use this skill to answer three questions about the current project: which Sonar
issues are open on this pull request or branch, what the quality gate says, and
why the `sonarqube` CI job failed.

## Operating rule

- Treat tool output as the only source of truth; never invent issues, rule ids,
  severities, or gate results.
- On ambiguity or an unexpected state, stop and ask instead of guessing.
- Discovery and read-only evidence never authorize a change to the repository.
- Report only what you actually read, and name what remains unproved.

## Task boundary

In scope: reading issues and gate status, mapping an issue to a file and rule,
planning a fix through EDT-MCP, and pointwise suppression in source code.

Out of scope: changing the Sonar server, its plugins, quality profiles, project
settings, or the shared `sonar-project.properties`. Those are user actions.

## Availability ladder

Check in this order and stop at the first step that works.

1. **Sonar MCP tools.** If the tool set contains `sonarqube_*`, call
   `sonarqube_system_status` first. If it answers, use the MCP tools for issues
   and gate. If it fails with `SonarQube authentication failed. Check the
   configured token`, record that exact text as the reason MCP is unavailable and
   go to step 2. Do not retry the same failing call.
2. **Local sonar CLI.** Run `Get-Command sonar`. If it resolves, run
   `sonar auth status` and look for a connected marker and a `Server` line for the
   host you are about to query. If the CLI is connected, do all work through it.
3. **Nothing available.** Stop and say plainly: Sonar is not configured in this
   environment. Do not substitute guesses. The only Sonar fact you may report is
   the quality-gate line from the CI job trace (see the GitLab skill for reading a
   job trace), and only as a gate fact — never as an issue list.

## Resolving project identity

Never hardcode a host, a project key, or a project id.

- **Host**: take it from the `Server` line of `sonar auth status`. Use it only to
  tell the user which instance you queried.
- **Project key**: read `sonar.projectKey` from the repository's
  `sonar-project.properties`:

```powershell
$projectKey = (Select-String -Path sonar-project.properties -Pattern '^sonar\.projectKey=(.+)$').Matches.Groups[1].Value.Trim()
```

  If the file is absent, use `sonar.projectKey` from the DSH settings file. If
  neither is set, ask the user — do not guess from the repository name.
- **Pull request**: the MR iid, not the issue number. Ask or read it from the MR
  URL when the user gives one.

## Reading issues

Always filter by status. Without `--statuses` the CLI also returns `FIXED`
history, which is not the current state.

```powershell
sonar list issues -p $projectKey --pull-request <iid> --statuses OPEN,CONFIRMED --format json --page-size 500 --page 1
sonar list issues -p $projectKey --branch <branch> --statuses OPEN,CONFIRMED --format json --page-size 500 --page 1
```

Parse the response and print one line per issue: file, line, rule, message.

```powershell
$page = sonar list issues -p $projectKey --pull-request <iid> --statuses OPEN,CONFIRMED --format json --page-size 500 --page 1 | ConvertFrom-Json
"total=$($page.total) page=$($page.p)"
foreach ($issue in $page.issues) {
  $file = $issue.component -replace '^[^:]+:', ''
  "{0}:{1}  {2}  {3}  {4}" -f $file, $issue.line, $issue.rule, $issue.severity, $issue.message
}
```

Pagination: `$page.paging.total` is the overall count, `$page.ps` the page size.
Loop `--page 1..N` only while `total` exceeds what you have read; do not fetch
pages you will not use.

Filtering by severity: `--severities` accepts values that depend on the server
mode (MQR: `INFO, LOW, MEDIUM, HIGH, BLOCKER`; standard: `INFO, MINOR, MAJOR,
CRITICAL, BLOCKER`). Ask the server by trying the standard set only when the user
asked for a severity filter; otherwise read everything and filter locally.

## Quality gate

MCP: `sonarqube_quality_gate`. CLI:

```powershell
sonar api GET "/api/qualitygates/project_status?projectKey=$projectKey&pullRequest=<iid>"
sonar api GET "/api/qualitygates/project_status?projectKey=$projectKey&branch=<branch>"
```

Read `projectStatus.status` and `projectStatus.conditions[]`
(`metricKey`, `comparator`, `errorThreshold`, `actualValue`, `status`).

- `OK` — gate passed.
- `ERROR` — at least one condition failed; report which metric and the actual
  value against the threshold.
- `NONE` — the gate was not computed for this branch or pull request. This is
  **not** a pass. Say that analysis has not run yet or that the reference branch
  has no analysis.

The endpoint argument must start with `/`; without it the CLI rejects the call.

## Work cycle for a fix

1. Pick one issue and resolve its file and rule.
2. Edit through EDT-MCP (`write_module_source` and related tools), never by
   editing `.bsl` files with filesystem tools.
3. Revalidate and check the project: `revalidate_objects`, then
   `get_project_errors`.
4. Commit and push only when the user asked for it (see the GitLab skill).
5. After the pipeline runs again, re-query issues with `--statuses
   OPEN,CONFIRMED` and confirm the issue is gone. Do not claim a fix from a
   green pipeline alone.

## Suppressions

Suppress only a single line or a single method, always with a reason comment,
and choose the syntax by rule id prefix.

| Rule id prefix | Suppression |
|---|---|
| `external_edt:` | `//@skip-check <rule-id>` on the line or above the method |
| `bsl-language-server:`, `external_bsl-language-server:` | `// bslls:<Rule>-off` before, `// bslls:<Rule>-on` after |

Never suppress a whole module when a pointwise suppression is enough. Never edit
the shared `sonar-project.properties` and never add global exclusions.

## Pitfalls

- Without `--statuses`, `FIXED` issues are included and the list looks wrong.
- An endpoint without a leading `/` fails in `sonar api`.
- PowerShell writes progress and warnings to stderr; `[exit code: 1]` in a tool
  result is not proof of failure. Check the actual output and the exit path.
- A green gate does not mean zero issues: the gate measures new code against a
  reference, while the issue list covers the whole project.
- A passing `sonarqube` job means the gate passed for that pipeline; it is not a
  list of issues. Do not present the job status as findings.

## Completion signal

Report: which availability step was used (MCP or CLI), the host and project key
you queried, the exact filter (`OPEN,CONFIRMED`, PR or branch), counts and the
issue list you actually read, and the gate status with failed conditions. If
Sonar was unavailable, say so and name the reason.
