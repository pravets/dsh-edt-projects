---
name: edt-mcp-project-gitlab
description: Commit, push, open or update a merge request, watch a pipeline, and read a failed job log through the glab CLI — «закоммить», «запушь», «сделай MR», «пайплайн», «glab», «почему упал пайплайн». Never merges, never force-pushes, never pushes to the main branch.
---

# EDT-MCP GitLab

## Purpose and trigger

Use this skill when the user asks to commit, push, open or update a merge
request, inspect a pipeline, or explain why a CI job failed in a GitLab-hosted 1C
project.

## Operating rule

- Remote-changing actions (commit, push, merge request, notes, job retry) happen
  only on an explicit user request.
- Treat tool output as the only source of truth; report what a command actually
  printed, including its exact error text.
- On ambiguity or an unexpected state, stop and ask instead of guessing.

## Task boundary

In scope: local git state, commit, push of a feature branch, merge request
creation and description updates, pipeline observation, job log reading.

Out of scope: merging a merge request, force-push, pushing to the main branch,
changing CI variables or project settings, storing tokens anywhere.

## Availability check

1. `Get-Command glab` — if it does not resolve, stop and say GitLab tooling is
   not configured here; propose the manual route (user commits and pushes
   themselves) instead of emulating the API with other tools.
2. `glab auth status` — read the output for the host taken from `git remote -v`
   and look for a line `✓ Logged in to <host> as <user>`. The command may exit
   non-zero because another configured host is not authenticated; that is not a
   failure for your host.
3. `git remote -v` — if there is no remote, stop: there is nothing to push to.

## Resolving identity

Never hardcode a host, project id, or branch name.

```powershell
$remote = git remote get-url origin
$branch = git branch --show-current
$project = glab api "projects/:fullpath" | ConvertFrom-Json
$projectId = $project.id
$target = $project.default_branch
```

`projects/:fullpath` and `projects/:id` are glab placeholders resolved from the
current repository; use them instead of literal paths and numbers.

## Commit

1. Inspect what will be committed: `git status --porcelain`, then `git diff`
   for the files you intend to include. Never `git add -A` when unrelated
   changes are present; stage explicit paths.
2. Title starts with the task number the repository uses (for example
   `#<task> <summary>`); body is a bullet list of what changed and why. Ask the
   user for the task number when it is not obvious.
3. Write the message to a file as UTF-8 **without BOM**, then commit with
   `git commit -F`. A BOM corrupts the title and can only be fixed by amending.

```powershell
$msgPath = Join-Path $env:TEMP 'commit-msg.txt'
$msg = @"
#<task> <summary>

- <change>
- <change>
"@
[System.IO.File]::WriteAllText($msgPath, $msg, (New-Object System.Text.UTF8Encoding($false)))
git commit -F $msgPath
```

`--amend` is allowed only for a commit that has not been pushed yet. Check with
`git status -sb` / `git log origin/<branch>..HEAD` before amending.

## Push

```powershell
git push -u origin $branch
git rev-parse HEAD
git rev-parse "origin/$branch"
```

`git push` writes progress to stderr, so a tool may report `[exit code: 1]` for a
successful push. Confirm the result by comparing the two revisions, or by the
`<old>..<new>  <branch> -> <branch>` line.

## AI-assisted note

The repository convention lives in its `AGENTS.md`; read it before writing the
note. The shape is a git note on the commit, added after the commit exists and
pushed separately, because notes do not travel with the branch:

```powershell
git notes --ref=refs/notes/ai-assisted add -m '{"ai":true,"model":"<model>"}' HEAD
git push origin refs/notes/ai-assisted
```

Ask the user which model or harness name to record; do not invent it.

## Merge request

Create through the API, because the description is multi-line. A JSON body sent
without `Content-Type: application/json` is rejected with HTTP 415.

```powershell
$body = @{
  source_branch        = $branch
  target_branch        = $target
  title                = $title
  description          = $description
  remove_source_branch = $true
  squash               = $false
} | ConvertTo-Json -Depth 5

$bodyPath = Join-Path $env:TEMP 'mr.json'
[System.IO.File]::WriteAllText($bodyPath, $body, (New-Object System.Text.UTF8Encoding($false)))
glab api --method POST "projects/:fullpath/merge_requests" --header "Content-Type: application/json" --input $bodyPath
```

Then read `iid`, `web_url`, `detailed_merge_status` from the response. Update the
description with `glab mr update <iid> -d <text>` (or a PUT to
`projects/:fullpath/merge_requests/<iid>`), and comment with
`glab mr note <iid> -m <text>`.

## Pipeline observation

A merge-request pipeline and a push pipeline are different objects. Read the
list, then follow the bridge into the child pipeline where the real jobs live.

```powershell
# Pipelines for the branch
glab api "projects/:id/pipelines?ref=$branch&per_page=20" | ConvertFrom-Json |
  ForEach-Object { "id=$($_.id) status=$($_.status) source=$($_.source) ref=$($_.ref)" }

# Child pipelines behind a bridge job
glab api "projects/:id/pipelines/<pipelineId>/bridges" | ConvertFrom-Json |
  ForEach-Object { "bridge=$($_.name) status=$($_.status) downstream=$($_.downstream_pipeline.id)" }

# Jobs of the child pipeline
glab api "projects/:id/pipelines/<downstreamId>/jobs?per_page=100" | ConvertFrom-Json |
  ForEach-Object { "job=$($_.id) $($_.name) status=$($_.status) stage=$($_.stage)" }

# Only the relevant lines of a job log
glab api "projects/:id/jobs/<jobId>/trace" | Select-String -Pattern '<pattern>' | Select-Object -Last 20
```

`source=merge_request_event` is a merge-request pipeline; `source=push` is a
branch pipeline and is often `manual`. Do not report a pipeline as green until
the child pipeline behind the bridge is checked.

Wait without busy-polling: re-read the status after a pause, and stop when the
status is terminal (`success`, `failed`, `canceled`, `skipped`). Do not loop
every second.

`glab ci list` has no `--branch` flag; use `-r/--ref <branch>` or the API above.

## Typical requests

- "commit and push" — stage explicit paths, commit, push, confirm revisions.
- "open a merge request" — push first if needed, then create, return the URL.
- "why did the pipeline fail" — find the failed job, read the tail of its trace,
  quote the failing lines, name the job and stage.
- "retry the failed job" — only on request: `glab ci retry <jobId>`.
- "update the merge request description" — `glab mr update` with the new text.

## Never

- Never merge a merge request, never force-push, never push to the default or
  main branch.
- Never change CI variables, runners, or project settings.
- Never commit secrets, tokens, or credentials; never print a token.
- Never `git add -A` when the working tree contains unrelated changes.
- Never claim success from an exit code alone when stderr carries progress.

## Completion signal

Report the branch, the commits created, the pushed revisions, the merge request
iid and URL, and the pipeline/job ids you actually queried with their final
status. When something failed, quote the lines from the trace that show why.
