# LEIA agent commands

Members of `leia-org` can ask `leia-org-bot` to change an open application PR by
posting a normal PR conversation comment starting with `/leia`:

```text
/leia fix merge conflicts of this branch
```

```text
/leia add x, update y and add a regression test for z
```

The model is `gpt-6-luna` with high reasoning effort. The **LEIA agent commands**
Actions workflow checks commands centrally. The [signed event receiver](events/README.md)
can wake it immediately after a comment, with a five-minute Cloudflare scheduled
backup. The GitHub cron and manual run remain available; GitHub's own scheduled
workflows can be delayed much longer than their configured interval. The model
does not control the event receiver or application deployments.

## Scope and authorization

The six supported repositories are Auth, Designer frontend/backend, Workbench
frontend/backend and Runner. A command must come from an active organization
member and refer to an open PR targeting `develop` or `main`. Its head must be in
the same repository and cannot be `main`. A release PR from `develop` to `main`
is supported. When the source branch is protected, the bot opens a repair PR into
that branch for normal review and approval; protections are never bypassed.
Merge conflict repair PRs with **Create a merge commit** to preserve the ancestry
needed to resolve the original PR. Forks, ordinary issues, quoted commands and bot comments do not run.

The initial scan records an activation time and ignores older comments. Each
comment ID is claimed durably before executing the model and processed once.
Editing a processed comment does not rerun it; post a new command to retry or ask
for another change. At most three commands are accepted per scan, at most two run
in parallel, and each PR has at most one command in a batch. Jobs have time limits.
Interrupted commands are not automatically replayed. The original comment, member
status, PR state and exact head/base commits are checked again before publication.
If someone pushes while the agent works, the bot stops instead of overwriting it.

## Generation, verification and publication

1. A trusted coordinator checks membership and snapshots the command and branches.
2. An isolated job checks out the exact PR head. Conflict requests (or a PR that
   GitHub already reports as conflicting) merge the exact base with `--no-commit`.
   The Codex GitHub Action runs the model with workspace write access, a proxy for
   the OpenAI API key and sudo removed. A trusted permission profile enables
   package-registry/GitHub downloads and local test servers through a domain
   allowlist, while keeping Git metadata read-only. It can inspect code, edit, run tests and
   iterate. It never receives a GitHub write token or hosting credentials.
3. A separate clean runner applies only a bounded patch and runs dependency
   installation and mandatory checks in a container without host credentials,
   Docker socket access or privileged capabilities. Frontends run their preview
   tests when available and `build:pre` (or `build` on branches predating it); APIs run Vitest once; Runner runs its unit
   suite (or Jest for branches predating that suite). Mandatory package scripts
   cannot be replaced by agent-generated no-op scripts. Any failure blocks the
   commit. This does not run against production data or credentials; tests needing
   unavailable external services must be replaced with appropriate isolated
   fixtures as part of the requested work, not weakened or skipped.
4. Only a trusted publisher receives an App token with Contents write permission.
   It requires the independent verification job to succeed, checks artifact and
   request hashes, validates file paths and rechecks current authorization. It
   creates one GitHub commit and updates an unprotected PR branch without force.
   Protected source branches receive a separate repair PR, without changing their
   protection settings. A conflict
   resolution uses both exact original head and base as parents. No PR is merged.

The bot maintains one response per command with the resulting commit, mandatory
check results and the Actions run link. Required repository CI still runs after
the App commit and human review remains necessary. Passing checks is evidence for
the covered behavior, not a guarantee that every behavior is correct.

Patches are limited to 200 files and 2 MiB. Workflow/action definitions, AGENTS.md,
Codex configuration, actual `.env` files, private keys, symlinks and submodules are
excluded. Environment examples can be documented without secret values. README
changes must be in English. No Codex/model `Co-Authored-By` trailer is added.
PrairieLearn is outside this integration's scope.

## Configuration

In `leia-infrastructure-docker`, keep the existing `LEIA_BOT_PRIVATE_KEY`,
`LEIA_BOT_APP_ID` and `LEIA_BOT_INSTALLATION_ID` settings and add the repository
Actions secret **OPENAI_API_KEY**. The API account must have access to
`gpt-6-luna`; no silent fallback to another model is used. API usage is billed to
that account. Enable the workflow with the repository variable
**LEIA_AGENT_ENABLED=true** only after configuring the secret and App permissions.

The App stays installed on the existing six application repositories with:

- Contents: read and write (commit publication).
- Pull requests: read and write (PR inspection and bot responses).
- Members: read (active organization membership checks).

Normal preview/promotion jobs still mint read-only Contents tokens. Only the
agent's trusted publisher opts into Contents write. The separate `leia-agent-state`
branch stores command IDs, hashes, commit references and statuses; it contains no
instructions, API keys or hosting environment values. Patch/check artifacts expire
after three days. Do not put credentials in command comments or source files.
