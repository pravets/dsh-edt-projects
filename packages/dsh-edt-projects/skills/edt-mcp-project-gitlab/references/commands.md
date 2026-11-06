# GitLab CLI cookbook

Copy-paste commands for Windows PowerShell. No host, project id, or branch is
hardcoded: resolve them first and keep them in variables.

```powershell
# 0. Availability
Get-Command glab
glab auth status            # look for "✓ Logged in to <host> as <user>"; exit code may be non-zero for other hosts
git remote -v

# 1. Identity of the current repository
$branch  = git branch --show-current
$project = glab api "projects/:fullpath" | ConvertFrom-Json
$projectId = $project.id
$target    = $project.default_branch
"project=$($project.path_with_namespace) id=$projectId default=$target branch=$branch"

# 2. What is going to be committed
git status --porcelain
git diff --stat
git diff -- <path>

# 3. Commit with a UTF-8 message without BOM
$msgPath = Join-Path $env:TEMP 'commit-msg.txt'
$msg = @"
#<task> <summary>

- <change>
"@
[System.IO.File]::WriteAllText($msgPath, $msg, (New-Object System.Text.UTF8Encoding($false)))
git add -- <path> [<path> ...]
git commit -F $msgPath

# 4. Push and confirm
git push -u origin $branch
git rev-parse HEAD
git rev-parse "origin/$branch"

# 5. AI-assisted note (format lives in the repository AGENTS.md)
git notes --ref=refs/notes/ai-assisted add -m '{"ai":true,"model":"<model>"}' HEAD
git push origin refs/notes/ai-assisted

# 6. Merge request through the API
$description = @"
## Что сделано
- <item>

## Проверки
- <check>
"@
$body = @{
  source_branch        = $branch
  target_branch        = $target
  title                = "<task> <summary>"
  description          = $description
  remove_source_branch = $true
  squash               = $false
} | ConvertTo-Json -Depth 5

$bodyPath = Join-Path $env:TEMP 'mr.json'
[System.IO.File]::WriteAllText($bodyPath, $body, (New-Object System.Text.UTF8Encoding($false)))
$mr = glab api --method POST "projects/:fullpath/merge_requests" --header "Content-Type: application/json" --input $bodyPath | ConvertFrom-Json
"iid=$($mr.iid) url=$($mr.web_url)"

# 7. Update the description, add a comment
glab mr update <iid> -d "<new description>"
glab mr note <iid> -m "<comment>"

# 8. Pipelines for the branch
glab api "projects/:id/pipelines?ref=$branch&per_page=20" | ConvertFrom-Json |
  ForEach-Object { "id=$($_.id) status=$($_.status) source=$($_.source) ref=$($_.ref)" }

# 9. Child pipeline behind a bridge
glab api "projects/:id/pipelines/<pipelineId>/bridges" | ConvertFrom-Json |
  ForEach-Object { "bridge=$($_.name) status=$($_.status) downstream=$($_.downstream_pipeline.id) ds_status=$($_.downstream_pipeline.status)" }

# 10. Jobs of the child pipeline
glab api "projects/:id/pipelines/<downstreamId>/jobs?per_page=100" | ConvertFrom-Json |
  ForEach-Object { "job=$($_.id) $($_.name) status=$($_.status) stage=$($_.stage)" }

# 11. Only the interesting part of a job log
glab api "projects/:id/jobs/<jobId>/trace" | Select-String -Pattern '<pattern>' | Select-Object -Last 20

# 12. Retry a failed job (only on explicit request)
glab ci retry <jobId>
```

## Notes

- `glab api` substitutes `:id`, `:fullpath`, `:branch`, `:repo` from the current
  repository; prefer them over literal paths and numbers.
- `glab api` flags: `-X/--method`, `-H/--header`, `--input <file|->`,
  `--paginate`, `-f/--field`, `--form`.
- `glab ci list` has no `--branch`; use `-r/--ref <branch>` or the pipelines API.
- Arrays from `ConvertFrom-Json` may print as one line (`id=1 2 3`); always pipe
  through `ForEach-Object` to get one record per line.
- PowerShell may print progress to stderr; a non-zero exit code alone does not
  prove failure — check the output.
- A BOM in the commit message file corrupts the title; use
  `UTF8Encoding($false)` or `Set-Content -Encoding utf8NoBOM` in PowerShell 7.
