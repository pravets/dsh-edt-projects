# Sonar CLI cookbook

Copy-paste commands for Windows PowerShell. Nothing here contains a fixed host,
project key, or pull-request id: resolve them first (see the skill) and keep them
in variables.

```powershell
# 1. Availability
Get-Command sonar
sonar system status          # AUTHENTICATION: Server + Token: Active; may exit non-zero on a healthy install
sonar auth status            # shorter form, same facts

# 2. Project key from the repository
$projectKey = (Select-String -Path sonar-project.properties -Pattern '^sonar\.projectKey=(.+)$').Matches.Groups[1].Value.Trim()
$projectKey

# 3. Or search the server by name when the file is absent
sonar list projects -q "<part of the project name>" --page-size 20

# 4. Issues of a merge request, compact form for reading
$iid = <iid>
sonar list issues -p $projectKey --pull-request $iid --statuses OPEN,CONFIRMED --format toon --page-size 500 --page 1

# 5. Same as JSON for parsing
$page = sonar list issues -p $projectKey --pull-request $iid --statuses OPEN,CONFIRMED --format json --page-size 500 --page 1 | ConvertFrom-Json
"total=$($page.total) page=$($page.p) pageSize=$($page.ps)"
foreach ($issue in $page.issues) {
  $file = $issue.component -replace '^[^:]+:', ''
  "{0}:{1}  {2}  {3}  {4}" -f $file, $issue.line, $issue.rule, $issue.severity, $issue.message
}

# 6. Same for a branch
$branch = '<branch>'
sonar list issues -p $projectKey --branch $branch --statuses OPEN,CONFIRMED --format toon --page-size 500 --page 1

# 7. Read every page when the result is large
$all = @()
for ($p = 1; ; $p++) {
  $chunk = sonar list issues -p $projectKey --pull-request $iid --statuses OPEN,CONFIRMED --format json --page-size 500 --page $p | ConvertFrom-Json
  $all += $chunk.issues
  if ($all.Count -ge $chunk.paging.total -or $chunk.issues.Count -eq 0) { break }
}
"issues=$($all.Count) total=$($chunk.paging.total)"

# 8. Quality gate for a merge request
sonar api GET "/api/qualitygates/project_status?projectKey=$projectKey&pullRequest=$iid"

# 9. Quality gate for a branch
sonar api GET "/api/qualitygates/project_status?projectKey=$projectKey&branch=$branch"

# 10. Gate conditions in readable form
$gate = sonar api GET "/api/qualitygates/project_status?projectKey=$projectKey&pullRequest=$iid" | ConvertFrom-Json
"status=$($gate.projectStatus.status)"
foreach ($c in $gate.projectStatus.conditions) {
  "{0} {1} {2} -> {3}" -f $c.metricKey, $c.comparator, $c.errorThreshold, $c.actualValue
}

# 11. Only discussions that block a merge request (different source, for contrast)
#     Merge request remarks live in GitLab, not in Sonar; see the GitLab skill.
```

## Response shapes

`sonar list issues --format json`:

```
{ total, p, ps, paging: { pageIndex, pageSize, total }, effortTotal,
  issues: [ { key, rule, severity, status, component, project, line, textRange, message, flows } ],
  components: [], facets: [] }
```

- `component` is `<project-key>:<relative/path/to/file>`; strip everything up to
  the first colon to get the path inside the repository.
- `status` values include `OPEN`, `CONFIRMED`, `FALSE_POSITIVE`, `ACCEPTED`,
  `FIXED`.

`sonar list issues --format toon` prints the same data as compact YAML-like
key/value blocks. It is easier to read but less convenient to parse; use JSON in
scripts.

`sonar api GET "/api/qualitygates/project_status..."`:

```
{ projectStatus: { status, conditions: [ { status, metricKey, comparator, errorThreshold, actualValue } ], period } }
```

## Notes

- `--format` also accepts `table` and `csv` for reading by eye; `json` is for
  parsing, `toon` is the compact one for reading in an agent session.
- `--severities` values depend on the server mode; when unsure, read without the
  filter and rank locally.
- `sonar api` takes the method first and the endpoint second; the endpoint must
  start with `/`. Use `--data '<json>'` for a request body.
- `sonar system status` may exit non-zero on a healthy installation — read the
  output instead of the exit code.
- PowerShell may print progress to stderr; judge by output, not by a non-zero
  exit code alone.
- Sonar issues are not merge request discussions: `glab mr note list` never shows
  them and `sonar list issues` never shows review threads.
