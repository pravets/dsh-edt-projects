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

# 2. Merge request iid for the branch
glab mr list --source-branch $branch -F json | ConvertFrom-Json |
  ForEach-Object { "iid=$($_.iid) $($_.title)" }

# 3. What is going to be committed
git status --porcelain
git diff --stat
git diff -- <path>

# 4. Commit with a UTF-8 message without BOM
$msgPath = Join-Path $env:TEMP 'commit-msg.txt'
$msg = @"
#<task> <summary>

- <change>
"@
[System.IO.File]::WriteAllText($msgPath, $msg, (New-Object System.Text.UTF8Encoding($false)))
git add -- <path> [<path> ...]
git commit -F $msgPath

# 5. Push and confirm
git push -u origin $branch
git rev-parse HEAD
git rev-parse "origin/$branch"

# 6. AI-assisted note (format lives in the repository AGENTS.md)
git notes --ref=refs/notes/ai-assisted add -m '{"ai":true,"model":"<model>"}' HEAD
git push origin refs/notes/ai-assisted
```

## Merge request body

Resolve the convention before writing: the repository `AGENTS.md`, then a
template in `.gitlab/merge_request_templates/`, then the fallback shape.

```powershell
# Which templates exist
Get-ChildItem .gitlab/merge_request_templates -Filter *.md -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty BaseName

# Fallback body shape (same as the `pr` skill unless the repository says otherwise)
$description = @"
## Summary

<smallest tree, diff or diagram that shows the change>

## Evidence

- **Before:** <output, test run or screenshot>
- **After:** <output, test run or screenshot>

## Merge Danger

**Door:** <one-way | two-way> — <why>

**Blast Radius:** <one word> — <what may break>
"@
```

Title: `<task> <summary>` in the repository style. Take the task number from the
branch (`feature/2520`), from `AGENTS.md`, or ask.

## Create

```powershell
# With a repository template; --template takes a name from .gitlab/merge_request_templates/
glab mr create `
  --source-branch $branch `
  --target-branch $target `
  --template <template-name> `
  --title "<task> <summary>" `
  --description "<short summary>" `
  --remove-source-branch `
  --yes --no-editor
```

`--fill` reads the title and body from commit messages and skips every prompt,
but ignores the template; `--fill --yes` is the fastest path for a small change
only when the user does not care about the body.

## Create with a multi-line body through the API

```powershell
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
"iid=$($mr.iid) url=$($mr.web_url) status=$($mr.detailed_merge_status)"
```

Without `Content-Type: application/json` the request is rejected with HTTP 415.

## Read and update

```powershell
# Current state: description, detailed_merge_status, pipeline, counters
glab mr view <iid> -F json

# Draft <-> ready
glab mr update <iid> --ready
glab mr update <iid> --draft

# Description from a UTF-8 file without BOM
$descriptionPath = Join-Path $env:TEMP 'mr-description.md'
[System.IO.File]::WriteAllText($descriptionPath, $description, (New-Object System.Text.UTF8Encoding($false)))
glab mr update <iid> --description (Get-Content -Raw -Path $descriptionPath)

# Labels and reviewers (repeat or comma-separated; prefix with + or - to add/remove)
glab mr update <iid> --label "<label>"
glab mr update <iid> --reviewer "+<username>"
```

## Review remarks

```powershell
# Convenience (experimental in glab): unresolved diff threads
glab mr note list <iid> --state unresolved --type diff -F json

# Stable route: every discussion with notes and positions
glab api "projects/:id/merge_requests/<iid>/discussions?per_page=100" | ConvertFrom-Json |
  ForEach-Object {
    $thread = $_
    foreach ($note in $thread.notes) {
      if ($note.system -eq $true) { continue }
      "discussion=$($thread.id) resolvable=$($note.resolvable) resolved=$($note.resolved) " +
        "author=$($note.author.username) at=$($note.position.new_path):$($note.position.new_line)"
      $note.body
      ""
    }
  }

# Compact summary of unresolved discussions
glab mr view <iid> -F json --unresolved

# Only discussions that still block the merge
glab api "projects/:id/merge_requests/<iid>/discussions?per_page=100" | ConvertFrom-Json |
  Where-Object { $_.notes | Where-Object { $_.resolvable -eq $true -and $_.resolved -eq $false } } |
  ForEach-Object { "open thread: $($_.id)" }
```

A discussion id is the 40-character hex `id`. `position.new_path` / `new_line`
point at the new side, `old_path` / `old_line` at the removed side. `system`
notes are events like "changed the description"; they are not review remarks.

## Answer and resolve

```powershell
# Reply into a thread (experimental; the prefix is at least 8 characters)
glab mr note create <iid> --reply <discussion-id-prefix> -m "<answer>"

# Reply through the API (stable)
glab api --method POST "projects/:id/merge_requests/<iid>/discussions/<discussion-id>/notes" -f "body=<answer>"

# Resolve (experimental; check the argument order with glab mr note resolve --help)
glab mr note resolve <discussion-id-prefix> <iid>

# Resolve through the API (stable)
glab api --method PUT "projects/:id/merge_requests/<iid>/discussions/<discussion-id>?resolved=true"

# A status note that must not block "all threads resolved"
glab mr note create <iid> -m "<status>" --resolvable=false
```

Resolve only after the fix is pushed and the reply names it. Never resolve a
thread to make the merge button green.

## Diff comments

```powershell
glab mr note create <iid> --file <path> --line <n> -m "<comment>"
glab mr note create <iid> --file <path> --line <from>:<to> -m "<comment>"
glab mr note create <iid> --file <path> --old-line <n> -m "<comment on a removed line>"
glab mr note create <iid> --file <path> -m "<file-level comment>"
```

`--line` and `--old-line` require `--file` and cannot be combined; `--file`,
`--reply` and `--unique` are mutually exclusive.

## Pipelines

```powershell
# Pipelines for the branch
glab ci list -r $branch -F json | ConvertFrom-Json |
  ForEach-Object { "id=$($_.id) status=$($_.status) source=$($_.source) ref=$($_.ref)" }

glab api "projects/:id/pipelines?ref=$branch&per_page=20" | ConvertFrom-Json |
  ForEach-Object { "id=$($_.id) status=$($_.status) source=$($_.source) ref=$($_.ref)" }

# Child pipeline behind a bridge
glab api "projects/:id/pipelines/<pipelineId>/bridges" | ConvertFrom-Json |
  ForEach-Object { "bridge=$($_.name) status=$($_.status) downstream=$($_.downstream_pipeline.id) ds_status=$($_.downstream_pipeline.status)" }

# Jobs of the child pipeline
glab api "projects/:id/pipelines/<downstreamId>/jobs?per_page=100" | ConvertFrom-Json |
  ForEach-Object { "job=$($_.id) $($_.name) status=$($_.status) stage=$($_.stage)" }

# Only the interesting part of a job log
glab api "projects/:id/jobs/<jobId>/trace" | Select-String -Pattern '<pattern>' | Select-Object -Last 20

# Retry a failed job (only on explicit request)
glab ci retry <jobId>
```

## Do not run

These are user actions, not agent actions:

```text
glab mr merge <iid>
glab mr merge <iid> --auto-merge
glab mr update <iid> --auto-merge
git push --force / git push -f
git push origin <protected-branch>
```

## Notes

- `glab api` substitutes `:id`, `:fullpath`, `:branch`, `:repo` from the current
  repository; prefer them over literal paths and numbers.
- `glab api` flags: `-X/--method`, `-H/--header`, `--input <file|->`,
  `--paginate`, `-f/--field`, `--form`.
- `glab ci list` has no `--branch`; use `-r/--ref <branch>` or the pipelines API.
- `glab mr note create|list|resolve|reopen` are marked experimental by glab: the
  flags and argument order may change between versions. The API route above is
  the stable one; check `glab mr note resolve --help` before relying on the CLI
  form.
- Arrays from `ConvertFrom-Json` may print as one line (`id=1 2 3`); always pipe
  through `ForEach-Object` to get one record per line.
- PowerShell may print progress to stderr; a non-zero exit code alone does not
  prove failure — check the output.
- A BOM in the commit message file corrupts the title; use
  `UTF8Encoding($false)` or `Set-Content -Encoding utf8NoBOM` in PowerShell 7.
