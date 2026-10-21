# LEIA agent event receiver

GitHub Actions scheduled workflows can start much later than their cron interval.
This Cloudflare Worker wakes the central agent workflow on a signed `issue_comment`
webhook. Its own five-minute scheduled trigger also checks for missed deliveries.
The existing GitHub cron and manual workflow dispatch remain available.

The receiver accepts new `/leia` commands on open PRs in the six application
repositories. It validates the raw-body HMAC before parsing it, rejects bots and
unexpected repositories, and checks active organization membership. It requests
a short-lived App token restricted to `leia-infrastructure-docker`, dispatches the
`leia-agent-command` repository event, and revokes that token. The central scanner
still independently checks current comments, membership and PR metadata; repeated
deliveries cannot repeat a claimed model command. No instruction text is sent in
the dispatch, and the receiver has no OpenAI key or frontend/backend credentials.

## Activation

1. Include `leia-infrastructure-docker` in the existing `leia-org-bot` installation.
   The App already has Contents write and Members read; no additional permission
   category is required. Its publisher tokens remain scoped to application repos.
2. Configure Worker secrets `LEIA_WEBHOOK_SECRET` (a random value of at least 32
   characters) and `LEIA_BOT_PRIVATE_KEY` (PKCS#8 PEM). Never commit either value.
   The GitHub App's downloaded RSA key can be converted to PKCS#8 locally.
3. Deploy `wrangler.jsonc` with Wrangler. The endpoint is
   `https://leia-agent-events.experimentia.workers.dev/github`.
4. Create one repository webhook in each supported application repository with
   event `issue_comment`, JSON content type, SSL verification enabled, the same
   secret, and that endpoint. Existing unrelated webhooks must remain intact.
5. Confirm a signed ping, a member comment's repository-dispatch run, the bot's
   response, and an idle repeat scan without another command claim.

`GET /health` reports whether the required bindings exist. HTTP 401 rejects an
invalid signature; HTTP 502 indicates a downstream authentication or dispatch
failure. No webhook body, signature, private key or token is logged. The receiver
keeps no command state; the central `leia-agent-state` branch owns deduplication.
If the installation no longer includes infrastructure, event and Cloudflare cron
wake-ups fail closed until access is restored.
