---
name: edt-mcp-project-sonar
description: Inspect SonarQube issues and the quality gate for the current 1C project — «замечания Sonar», «гейт SonarQube», «почему падает sonarqube», SonarQube issues, quality gate status, failed sonarqube job. Works through Sonar MCP tools when they answer and through the local sonar CLI otherwise. Not for configuring the Sonar server or editing sonar-project.properties.
---

# SonarQube through the sonar CLI

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
   `sonar system status` and read the `AUTHENTICATION` block: a `Server` line and
   `Token: Active` mean the CLI is usable. `sonar auth status` prints the same
   facts in a shorter form. **`sonar system status` may exit non-zero even when
   every check is healthy** — judge by the output, not by the exit code.
3. **Nothing available.** Stop and say plainly: Sonar is not configured in this
   environment. Do not substitute guesses. The only Sonar fact you may report is
   the quality-gate line from the CI job trace (see the GitLab skill for reading a
   job trace), and only as a gate fact — never as an issue list.

## Resolving project identity

Never hardcode a host, a project key, or a project id.

- **Host**: take it from the `Server` line of `sonar auth status` or
  `sonar system status`. Use it only to tell the user which instance you queried.
- **Project key**: read `sonar.projectKey` from the repository's
  `sonar-project.properties`:

```powershell
$projectKey = (Select-String -Path sonar-project.properties -Pattern '^sonar\.projectKey=(.+)$').Matches.Groups[1].Value.Trim()
```

  If the file is absent, use `sonar.projectKey` from the DSH settings file. If
  neither is set, search the server by a distinctive part of the project name
  instead of guessing, and read every page until the exact match appears or the
  pages run out:

```powershell
$query = "<part of the project name>"
$found = @()
for ($page = 1; ; $page++) {
  $result = sonar list projects -q $query --page-size 50 --page $page | ConvertFrom-Json
  $found += $result.projects
  if ($result.paging.hasNextPage -ne $true) { break }
}
$found | ForEach-Object { "{0}  {1}" -f $_.key, $_.name }
```

  Pick the exact match and show it to the user; do not silently choose the first
  hit.
- **Pull request**: the merge request iid, not the issue number. Ask or read it
  from the merge request URL when the user gives one.

## Reading issues

Always filter by status. Without `--statuses` the CLI also returns `FIXED`
history, which is not the current state.

```powershell
# Compact form for reading: fewer tokens than JSON
sonar list issues -p $projectKey --pull-request <iid> --statuses OPEN,CONFIRMED --format toon --page-size 500 --page 1

# JSON for parsing
sonar list issues -p $projectKey --pull-request <iid> --statuses OPEN,CONFIRMED --format json --page-size 500 --page 1

# Same for a branch
sonar list issues -p $projectKey --branch $branch --statuses OPEN,CONFIRMED --format toon --page-size 500 --page 1
```

Parse the JSON response and print one line per issue: file, line, rule, message.

```powershell
$page = sonar list issues -p $projectKey --pull-request <iid> --statuses OPEN,CONFIRMED --format json --page-size 500 --page 1 | ConvertFrom-Json
"total=$($page.total) page=$($page.p) pageSize=$($page.ps)"
foreach ($issue in $page.issues) {
  $file = $issue.component -replace '^[^:]+:', ''
  "{0}:{1}  {2}  {3}  {4}" -f $file, $issue.line, $issue.rule, $issue.severity, $issue.message
}
```

Pagination: `paging.total` is the overall count, `paging.pageSize` the page size.
Loop `--page 1..N` only while the collected count is below `paging.total`; do not
fetch pages you will not use.

Filtering by severity: `--severities` accepts values that depend on the server
mode (MQR: `INFO, LOW, MEDIUM, HIGH, BLOCKER`; standard: `INFO, MINOR, MAJOR,
CRITICAL, BLOCKER`). Ask the server by trying the standard set only when the user
asked for a severity filter; otherwise read everything and filter locally.

## Quality gate

MCP: `sonarqube_quality_gate`. CLI:

```powershell
$branchParam = [uri]::EscapeDataString($branch)
sonar api GET "/api/qualitygates/project_status?projectKey=$projectKey&pullRequest=<iid>"
sonar api GET "/api/qualitygates/project_status?projectKey=$projectKey&branch=$branchParam"
```

Branch names may contain `+`, `&` and `#`, so encode the branch before putting it
into the endpoint.

Read `projectStatus.status` and `projectStatus.conditions[]`
(`metricKey`, `comparator`, `errorThreshold`, `actualValue`, `status`).

- `OK` — gate passed.
- `ERROR` — at least one condition failed; report which metric and the actual
  value against the threshold.
- `NONE` — the gate was not computed for this branch or pull request. This is
  **not** a pass. Say that analysis has not run yet or that the reference branch
  has no analysis.

The endpoint argument must start with `/`; without it the CLI rejects the call.
`sonar api` takes the method as the first argument (`GET`, `POST`, …), the
endpoint as the second, and `--data '<json>'` for a body.

## Merge request remarks are not Sonar issues

Sonar findings never appear in `glab mr note list` and review discussions never
appear in `sonar list issues`. When the user asks for "все замечания", report
both lists separately and name their source:

- Merge request discussions — `edt-mcp-project-gitlab`.
- Sonar issues and gate — this skill.

Do not merge the two lists into one, and do not present a green `sonarqube` CI
job as a list of findings.

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
- `sonar system status` and `sonar auth status` may exit non-zero on a healthy
  installation; read the output.
- An endpoint without a leading `/` fails in `sonar api`.
- `--format toon` is compact and good for reading; parsing code should use
  `--format json` because field names and nesting differ.
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
Sonar was unavailable, say so and name the reason. If the user asked for merge
request remarks too, say that they come from a different source and name it.
