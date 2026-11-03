# Sonar CLI cookbook

Copy-paste commands for Windows PowerShell. Nothing here contains a fixed host,
project key, or pull-request id: resolve them first (see the skill) and keep them
in variables.

```powershell
# 1. Availability
Get-Command sonar
sonar auth status            # read the "Server" line; the exit code may be non-zero for other hosts

# 2. Project key from the repository
$projectKey = (Select-String -Path sonar-project.properties -Pattern '^sonar\.projectKey=(.+)$').Matches.Groups[1].Value.Trim()
$projectKey

# 3. Issues of a merge request, current state only
$iid = <iid>
$page = sonar list issues -p $projectKey --pull-request $iid --statuses OPEN,CONFIRMED --format json --page-size 500 --page 1 | ConvertFrom-Json
"total=$($page.total)"
foreach ($issue in $page.issues) {
  $file = $issue.component -replace '^[^:]+:', ''
  "{0}:{1}  {2}  {3}  {4}" -f $file, $issue.line, $issue.rule, $issue.severity, $issue.message
}

# 4. Same for a branch
$branch = '<branch>'
sonar list issues -p $projectKey --branch $branch --statuses OPEN,CONFIRMED --format json --page-size 500 --page 1 | ConvertFrom-Json |
  Select-Object -ExpandProperty issues |
  ForEach-Object { "{0}:{1}  {2}  {3}" -f ($_.component -replace '^[^:]+:', ''), $_.line, $_.rule, $_.message }

# 5. Read every page when the result is large
$all = @()
for ($p = 1; ; $p++) {
  $chunk = sonar list issues -p $projectKey --pull-request $iid --statuses OPEN,CONFIRMED --format json --page-size 500 --page $p | ConvertFrom-Json
  $all += $chunk.issues
  if ($all.Count -ge $chunk.total -or $chunk.issues.Count -eq 0) { break }
}
"issues=$($all.Count)"

# 6. Quality gate for a merge request
sonar api GET "/api/qualitygates/project_status?projectKey=$projectKey&pullRequest=$iid"

# 7. Quality gate for a branch
sonar api GET "/api/qualitygates/project_status?projectKey=$projectKey&branch=$branch"

# 8. Gate conditions in readable form
$gate = sonar api GET "/api/qualitygates/project_status?projectKey=$projectKey&pullRequest=$iid" | ConvertFrom-Json
"status=$($gate.projectStatus.status)"
foreach ($c in $gate.projectStatus.conditions) {
  "{0} {1} {2} -> {3}" -f $c.metricKey, $c.comparator, $c.errorThreshold, $c.actualValue
}
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

`sonar api GET "/api/qualitygates/project_status..."`:

```
{ projectStatus: { status, conditions: [ { status, metricKey, comparator, errorThreshold, actualValue } ], period } }
```

## Notes

- `--format` also accepts `table` and `csv` for reading by eye; `json` is for
  parsing.
- `--severities` values depend on the server mode; when unsure, read without the
  filter and rank locally.
- PowerShell may print progress to stderr; judge by output, not by a non-zero
  exit code alone.
