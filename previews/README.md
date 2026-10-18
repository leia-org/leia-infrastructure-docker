# Linked preview environments

This directory defines the PR linking contract and a read-only deployment planner.
It does not yet deploy applications, clone databases, rebuild frontend assets or
handle PR cleanup. Existing Cloudflare frontend previews continue to use stable
pre backends until the coordinator is connected.

## Link changes across repositories

Copy the JSON block in [the PR template](pull_request_template.md) into every PR
being tested together. Use one shared environment name and identical full PR URLs.
Do not match PR numbers across repositories: Designer frontend PR 108 and Designer
backend PR 73 are independent identifiers. The example numbers are illustrative;
the planner never creates links automatically.

```sh
node --test previews/manifest.test.mjs
node previews/plan.mjs /path/to/pull-request-body.md
```

`GITHUB_TOKEN` is optional for public repository reads but avoids anonymous API
rate limits. The planner validates reciprocal links, trusted same-repository PRs
targeting `develop`, open PR state and exact commit SHAs. It produces public URLs
and Vite build variables only. It does not read deployment credentials.

## Deployment contract

| Environment | Code | MongoDB | Redis |
|---|---|---|---|
| Production | `main` | Existing Atlas production databases | Existing production Redis |
| Stable pre | `develop` | Existing Atlas pre databases | Existing pre Redis |
| Linked PR environment | Linked PR commits; other backend services pinned to `develop` | Separate databases seeded from pre | Separate Redis instance or equivalently isolated store |

Each PR environment must run Auth, Designer API, Workbench API and Runner together,
including unchanged backend services. This prevents callbacks from writing into
stable pre through another service. An omitted frontend retains its stable pre
URL; in particular, Designer can continue to open the stable Workbench frontend.

PR backend hosts use `pr-<environment>-<service>.leia.ovh`, keeping them below the
zone's ordinary wildcard TLS certificate. Frontends retain their existing
`pre-<PR>.designer.leia.ovh` and `pre-<PR>.workbench.leia.ovh` URLs. DNS records for
these backend hosts must point to Hetzner separately from the frontend Workers.

The future coordinator must:

1. Resolve and validate all reciprocal PR blocks and pin their commits.
2. Create the isolated data stores and backend resources without publishing a
   ready frontend URL yet.
3. Copy the three pre MongoDB databases, preserving BSON values, collection options
   and indexes. Use credentials scoped to the target databases. Never restore over
   pre or production. Seed once when creating the environment; ordinary commits
   must preserve test data.
4. Preserve `API_KEY_STORAGE_SECRET` where needed to decrypt copied API key data,
   while generating separate internal service credentials and JWT signing keys.
5. Wire every backend dependency to the same environment, wait for readiness and
   build the frontend assets with the planner's Vite variables.
6. Publish frontend assets and report the deployed commits and URLs on each PR.
7. Reconcile changes to PR metadata and code; reconcile both sides when a link is
   removed. Keep the environment while another open linked PR still needs it.
   Delete only the group's resources and data after the last linked PR closes.

Vite variables are compiled into the frontend assets. Adding runtime Worker vars
does not change the backend URL of an existing static asset build. Native Coolify
PR previews alone do not implement cross-repository links or data seeding.

The Hetzner server currently has 4 CPU and about 7.6 GiB RAM. Set a measured active
environment limit, build concurrency and cleanup policy before enabling all open
backend PRs. Do not provision extra paid capacity automatically.

Fork PR deployment requires a separately reviewed path. Do not expose deployment
secrets through a privileged workflow that executes the PR's build scripts. Keep
backend credentials in Coolify, build frontend code without deployment secrets,
and publish its artifacts from a separate trusted job. Public pre and PR sites
remain public; Cloudflare Access is deferred.

External integrations such as AI providers, object storage and Ollama need an
explicit preview policy. Database isolation does not isolate shared external
accounts or image buckets automatically.

## References

- [Coolify preview deployments](https://coolify.io/docs/applications/deployments/preview-deployments)
- [Cloudflare Workers GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
