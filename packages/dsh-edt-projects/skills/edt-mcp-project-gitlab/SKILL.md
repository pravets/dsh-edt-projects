---
name: edt-mcp-project-gitlab
description: Commit, push, open or update a merge request, read and answer review remarks, resolve discussions, watch a pipeline and read a failed job log through the glab CLI — «закоммить», «запушь», «сделай MR», «оформи MR», «замечания ревью», «обсуждения в MR», «ответь на комментарий», «резолвни тред», «пайплайн», «glab», «почему упал пайплайн». Never merges without an explicit user request, never force-pushes, never pushes to the main branch.
---

# GitLab through glab

## Purpose and trigger

Use this skill when the user asks to commit, push, open or update a merge
request, inspect review remarks, answer a review comment, resolve a discussion,
inspect a pipeline, or explain why a CI job failed in a GitLab-hosted 1C project.

## Operating rule

- Remote-changing actions (commit, push, merge request, notes, job retry) happen
  only on an explicit user request.
- Treat tool output as the only source of truth; report what a command actually
  printed, including its exact error text.
- On ambiguity or an unexpected state, stop and ask instead of guessing.

## Merge is forbidden without an explicit request

A green pipeline, a passed quality gate, reviewer approval and a `mergeable`
status are **not** permission to merge. Merging is the user's action.

- Never run `glab mr merge`, `glab mr merge --auto-merge`, `glab mr update
  --auto-merge`, or any local `git merge` / rebase of the target branch, unless
  the user asked in a separate message to merge exactly this merge request.
- When everything is ready, stop and report: the merge request iid and URL, the
  pipeline and gate status, the unresolved discussion count, and the line
  "готов к мержу, жду вашего решения". Then wait.
- Do not treat "merge" words in another context (merge conflict, merge request)
  as permission to merge.

## Task boundary

In scope: local git state, commit, push of a feature branch, merge request
creation and description updates, review remarks and discussions, pipeline
observation, job log reading.

Out of scope: merging a merge request, auto-merge, force-push, pushing to the
main branch, changing CI variables or project settings, storing tokens anywhere.

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

The merge request iid is not the task number and not the branch name. When the
user does not give an iid, find the open merge request for the branch:

```powershell
glab mr list --source-branch $branch -F json | ConvertFrom-Json |
  ForEach-Object { "iid=$($_.iid) $($_.title)" }
```

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

## Merge request body

Never invent the body structure. Resolve the convention in this order:

1. The repository's `AGENTS.md` — read it and follow any merge request rules
   there.
2. A template: look for `.gitlab/merge_request_templates/*.md` and pass its name
   with `--template <name>`; the `.md` extension is optional and templates are
   loaded from the local repository only.
3. Fallback: the same shape the `pr` skill uses, unless the repository says
   otherwise:

```markdown
## Summary

<smallest diagram, tree or diff that shows the change>

## Evidence

- **Before:** <output, test run or screenshot>
- **After:** <output, test run or screenshot>

## Merge Danger

**Door:** <one-way or two-way> — <why it is cheap or expensive to roll back>

**Blast Radius:** <one word> — <what may break and for whom>
```

Rules for the body:

- Summary shows the smallest view that makes the point: a call tree, a file
  tree, a diff sketch or a Mermaid diagram, not a retelling of the diff.
- Evidence is concrete: command output, test counts, `get_project_errors` result
  for 1C changes. "Works" without evidence is not evidence.
- Merge Danger: a one-way door means data migration, destructive action or a
  decision that is hard to reverse; two-way means a plain revert is enough.
- Title: `<task> <summary>` in the repository's style; take the task number from
  the branch (`feature/2520`) or from `AGENTS.md`, ask when unsure.
- Language: match the repository (`AGENTS.md`, README, recent merge requests).

## Creating a merge request

Prepare the body first: `$description` by the rules above or, when the repository
has a template, let `--template` fill it. Create without interactive prompts,
otherwise the command blocks the session.

With a repository template (glab 1.113 makes `--template` and `--description`
mutually exclusive, so the template supplies the body):

```powershell
glab mr create `
  --source-branch $branch `
  --target-branch $target `
  --title "<task> <summary>" `
  --template <template-name> `
  --yes --no-editor
```

Without a template, swap `--template <template-name>` for
`--description $description`. A multi-line body goes through the API below.

Flag notes:

- `--fill` takes the title and body from commit messages and skips all prompts,
  but it ignores the repository template and usually produces a weak body — use
  it only when the user explicitly wants a quick MR.
- `--draft` / `--wip` creates a draft; do not create ready-for-review MRs for
  unfinished work.
- `--reviewer <user>` and `--label <name>` repeat or take comma-separated lists.
- `--squash-before-merge` and `--remove-source-branch` are not passed by default:
  omitting them keeps the project settings. Add them only when the user or the
  repository convention asks, because `--remove-source-branch` deletes the
  source branch after the merge.
- `--description` and `--template` cannot be combined; `--template` also cannot
  be combined with `--fill` or `--related-issue`.

For a multi-line body use the API, because the description is JSON and a
PowerShell here-string loses nothing:

```powershell
$description = @"
## Summary

<...>

## Evidence

- **Before:** <...>
- **After:** <...>

## Merge Danger

**Door:** two-way — <...>

**Blast Radius:** small — <...>
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
"iid=$($mr.iid) url=$($mr.web_url) status=$($mr.detailed_merge_status)"
```

A JSON body sent without `Content-Type: application/json` is rejected with HTTP
415 — the header is not optional.

Read `iid`, `web_url`, `detailed_merge_status` from the response and report them.

## Updating the merge request

```powershell
glab mr update <iid> --description (Get-Content -Raw -Path $descriptionPath)
glab mr update <iid> --title "<new title>"
glab mr update <iid> --ready        # draft -> ready for review
glab mr update <iid> --draft
```

`glab mr view <iid> -F json` returns the current description, `detailed_merge_status`,
pipeline state and discussion counters; read it before updating so the old body
is not lost.

## Review remarks and discussions

Read the remarks that block the merge first. Both routes are acceptable; the API
is the stable one, the `note` subcommands are marked experimental by glab.

### Read unresolved discussions

```powershell
# Convenience (experimental): every unresolved discussion, diff and general alike
glab mr note list <iid> --state unresolved -F json

# Narrow it to diff threads only when that is what the user asked for
glab mr note list <iid> --state unresolved --type diff -F json

# Stable: every discussion of the merge request, all pages
$threads = @()
for ($page = 1; ; $page++) {
  $chunk = glab api "projects/:id/merge_requests/<iid>/discussions?per_page=100&page=$page" | ConvertFrom-Json
  $threads += $chunk
  if ($chunk.Count -lt 100) { break }
}
$threads | ForEach-Object {
  $thread = $_
  foreach ($note in $thread.notes) {
    if ($note.system -eq $true) { continue }
    # A comment on a removed line has no new_* position; fall back to old_*.
    $where = if ($null -eq $note.position) { 'general' } else {
      $file = $note.position.new_path ?? $note.position.old_path
      $line = $note.position.new_line ?? $note.position.old_line
      "${file}:${line}"
    }
    "discussion=$($thread.id) resolvable=$($note.resolvable) resolved=$($note.resolved) author=$($note.author.username) at=$where"
    $note.body
    ""
  }
}
```

Do not filter by `--type diff` when checking readiness: a general resolvable
discussion can block "all threads must be resolved" just like a diff thread.

Field notes: a discussion id is the 40-character hex string in `id`; `notes[]`
carries `body`, `author.username`, `resolvable`, `resolved`, `system` and
`position` (`new_path`, `new_line`, `old_path`, `old_line`). A system note is a
"changed the description" style event — never report it as a review remark.

For a compact summary use `glab mr view <iid> -F json --unresolved`, which adds a
`Discussions` array to the merge request object.

Report each remark as `file:line`, author, rule or subject, and the body. Do not
paraphrase away the requirement; quote the actionable sentence.

### Answer a discussion

```powershell
# Experimental convenience; the prefix is at least 8 characters of the discussion id
glab mr note create <iid> --reply <discussion-id-prefix> -m "<answer>"

# Stable: reply into the thread
glab api --method POST "projects/:id/merge_requests/<iid>/discussions/<discussion-id>/notes" -f "body=<answer>"
```

An answer states what was changed and where, or asks a concrete question. "Done"
alone is not an answer.

### Resolve a discussion

```powershell
# Experimental; check the argument order of the installed glab with --help first
glab mr note resolve <discussion-id-prefix> <iid>

# Stable: resolve explicitly
glab api --method PUT "projects/:id/merge_requests/<iid>/discussions/<discussion-id>?resolved=true"
```

Resolve only after the fix exists in the pushed commit and the reply names it.
Never resolve a discussion that was not addressed, never resolve threads to make
the merge button green, and never resolve someone else's thread on the user's
behalf without an explicit request.

### Comment on a line of the diff

```powershell
glab mr note create <iid> --file <path> --line <n> -m "<comment>"
glab mr note create <iid> --file <path> --line <from>:<to> -m "<comment>"
glab mr note create <iid> --file <path> --old-line <n> -m "<comment on removed line>"
```

`--file` targets the latest diff version; `--line` is the new side, `--old-line`
the removed side, and the two cannot be combined. `--unique` skips the note when
the same body already exists. For a status note that must not block "all threads
resolved", pass `--resolvable=false`.

### Remarks from Sonar

Sonar issues are not merge request discussions. Read them with the Sonar skill
(`edt-mcp-project-sonar`); a Sonar finding never appears in `glab mr note list`.

## Pipeline observation

A merge-request pipeline and a push pipeline are different objects. Read the
list, then follow the bridge into the child pipeline where the real jobs live.

```powershell
# Pipelines for the branch: JSON, one object per pipeline
glab ci list -r $branch -F json | ConvertFrom-Json |
  ForEach-Object { "id=$($_.id) status=$($_.status) source=$($_.source) ref=$($_.ref)" }

# Pipelines through the API (same fields, plus bridges below)
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
- "open a merge request" / "оформи MR" — push first if needed, read the
  repository convention, create with a template or the fallback body, return the
  URL and status.
- "what are the review remarks" — read unresolved discussions, report file, line,
  author and the requirement.
- "answer the review" — fix first, reply into the thread, then resolve when the
  user asked for it or the repository convention allows.
- "why did the pipeline fail" — find the failed job, read the tail of its trace,
  quote the failing lines, name the job and stage.
- "retry the failed job" — only on request: `glab ci retry <jobId>`.
- "update the merge request description" — `glab mr update` with the new text.
- "merge it" — only with an explicit request for this merge request; otherwise
  report readiness and stop.

## Never

- Never merge a merge request without an explicit user request for that merge
  request; never enable auto-merge.
- Never force-push, never push to the default or main branch.
- Never resolve discussions that were not addressed, and never resolve threads to
  unblock a merge.
- Never change CI variables, runners, or project settings.
- Never commit secrets, tokens, or credentials; never print a token.
- Never `git add -A` when the working tree contains unrelated changes.
- Never claim success from an exit code alone when stderr carries progress.

## Completion signal

Report the branch, the commits created, the pushed revisions, the merge request
iid and URL, the discussion ids you read or answered with their state, and the
pipeline/job ids you actually queried with their final status. When something
failed, quote the lines from the trace that show why. If the merge request is
ready, say it is ready and that merging waits for the user's decision.
