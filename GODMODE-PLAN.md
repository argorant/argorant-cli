# God-mode campaigns from the terminal

Goal: `argorant campaigns create` -> `steps set` -> `inboxes attach` ->
`leads add` -> `start`, a live outbound campaign in about two minutes, no
browser.

**Status: implemented.** The auth gap documented below (phase 1) has been
closed server-side (an operator-key bridge in `api/auth.py`); the full
`argorant campaigns ...` command group is wired up and mock-verified against
every endpoint signature. See "What's implemented" at the bottom for the
final command list and the one known platform-side gap.

## The auth model (read this first)

Every other CLI command (`count`/`search`/`reveal`/`export`/`list`/`verify`)
authenticates with an `ag_live_*` API key against `/api/mcp/*` — the
customer-facing contact-data surface, gated by plan scopes
(`_get_mcp_credential()` in `api/main.py`).

`argorant campaigns ...` talks to a different surface entirely:
`/api/sequencer/*`, the internal Argorant Sequencer that runs live outbound
campaigns. Those routes are gated by `Depends(get_current_user)` from
`api/auth.py`, which normally only accepts a session JWT (cookie or Bearer) —
an `ag_live_*` key used to fail there immediately with 401 "Invalid token",
before any scope check even ran.

That gap is now closed by a small, additive bridge in `api/auth.py`
(`_try_operator_key_auth`, called from `get_current_user` only when the
Bearer token starts with `ag_live_`):

- The key is resolved the same way `/api/mcp/*` already resolves it
  (`_get_mcp_credential()` → `mcp_connector_credentials` joined to `users`).
- It's only honored if the key carries the new `argorant:operator` scope
  **and** its owning user's role is `owner` or `admin`.
- On success it returns a `get_current_user`-shaped `{"id", "email", "role"}`
  dict, so every existing internal gate downstream
  (`_require_internal_operator`, `_require_outbound_surface`,
  `_require_outbound_admin_for_override` — all of which short-circuit true for
  `role in ("owner", "admin")`) passes exactly as it would for a real owner/
  admin browser session. No sequencer endpoint needed to change.
- Any other key (wrong scope, member/employee role, revoked, unknown) falls
  through unchanged to the original `jwt.decode()` path, which rejects it
  with the same 401 as before — zero behavior change for non-operator keys.

Net effect: an `ag_live_*` key with `argorant:operator` scope on an
owner/admin account now drives `/api/sequencer/*` exactly like the app UI
does. It is deliberately **not** a customer-facing capability — campaigns
stay an internal Hermes/outbound tool; this only lets internal tooling (this
CLI) skip the browser.

## The flow, mapped to endpoints (verified read-only against `api/main.py`)

| CLI command | Endpoint | Notes |
|---|---|---|
| `campaigns list [--brand <key>]` | `GET /api/sequencer/campaigns?include_counts=true` | Returns `status`, `sent_count`, `replied_count`, `positive_reply_count`, `bounced_count`, `queued_count`, `inbox_count` per campaign directly — list command is a straight passthrough. |
| `campaigns create --name ... [--brand] [--timezone] [--window] [--skip-weekends]` | `POST /api/sequencer/campaigns` | `SequencerCampaignCreateRequest` has ~30 fields (ICP, copy mode, delivery backend, Hermes settings...) built for the app's wizard; the CLI sends sane server defaults for everything it doesn't expose, and forces `lead_source: "manual"` (the server default, `argorant_campaign`, requires a `source_outbound_campaign_id` this command doesn't collect — leads are added afterwards via `leads add`). |
| `campaigns steps set <id> --step <n> --subject ... (--body-file \| --body)` | `POST /api/sequencer/campaigns/{id}/steps` | One call per step (subject/body/day-offset); `copy_status` is `"approved"` with `--approve`, else `"draft"`. The CLI never generates copy — it only upserts what it's given. |
| `campaigns inboxes attach <id> --count <n> [--pool <brand>]` | `GET /api/sequencer/campaigns/{id}/inboxes` (already-attached) + `GET /api/sequencer/inboxes?status=usable&brand=<pool>` (candidate pool, paginated) + `POST /api/sequencer/campaigns/{id}/inboxes` (`inbox_emails: [...]`) | "Unattached" is scoped to *this* campaign (an inbox can serve several campaigns via the `sequencer_campaign_inboxes` join table); `status=usable` is the same active+connected+healthy+has-capacity filter the app's Inboxes page uses. Explicit fleet change — prints exactly which emails were attached. |
| `campaigns leads add <id> --csv <file>` | `POST /api/sequencer/campaigns/{id}/leads/import` (`csv_text`) | Full CSV → lead-row parsing (email/first_name/last_name/company/title/industry/city/state/country/phone/...) already existed server-side; the CLI just reads the file and posts it. |
| `campaigns leads add <id> --query "..." [filters]` | `POST /api/sequencer/campaigns/{id}/leads/import` (`filters: {...}`) | **This is a direct server-side search-to-enroll path that phase 1 hadn't found** — `import_sequencer_leads` accepts a `filters` dict (same keys as the MCP people search: `title`, `seniority`, `departments`, `industry`, `country`, `city`, `state`, `company_name`, `company_domain`, `has_email`, `has_phone`, `has_linkedin`, `q`, ...) and enrolls straight off Elasticsearch via `_sequencer_import_filter`, with no saved list needed. |
| `campaigns start <id>` / `campaigns pause <id>` | `PATCH /api/sequencer/campaigns/{id}` body `{"status": "active"}` / `{"status": "paused"}` | Start auto-approves any draft step with real subject+body and background-schedules sends (matches the product's Start/Pause/Stop/Update model — no separate approval ceremony). A 400 with a structured `{"message", "blockers": [...]}` detail means the campaign isn't launchable yet; the CLI prints each blocker. |
| `campaigns status <id>` | `GET /api/sequencer/campaigns/{id}` | Returns `step_count`/`approved_step_count`, `inbox_count`, `lead_count`/`queued_count`, and `launch_blockers` (computed server-side by `_sequencer_launch_blockers`) in one call — the CLI renders setup completeness directly from this. |

`<campaign>` (every subcommand above except `create`) accepts a raw uuid or
an unambiguous case-insensitive name prefix, resolved via `campaigns list`
under the hood; an ambiguous prefix errors listing every match instead of
guessing.

## Known gap: no row cap on `leads add --query`

`import_sequencer_leads`'s `filters` path (`_sequencer_import_filter`) has no
per-request `limit`/`-n` parameter — it scans and enrolls every valid match up
to its own server-side cap (`ARGORANT_SEQUENCER_FILTER_ENROLL_CAP`, default
50,000), not a value the caller can set. `-n`/`--limit` is accepted on
`campaigns leads add --query` for a familiar CLI surface (matching
`search`/`reveal`/`export` elsewhere) but is **not forwarded or honored**; the
CLI warns on stderr rather than silently dropping it. `--csv` has no such
limitation (it imports exactly the rows in the file). Fixing this would need
a new server-side param threaded through `_sequencer_import_filter`'s ES
scroll loop — flagging, not fixing, here per the CLI-only scope of this round.

## What's implemented

`argorant campaigns list|create|steps set|inboxes attach|leads add|start|pause|status`
— the full command set from the brief, all against real endpoint signatures
read directly out of `api/main.py` (not guessed), mock-server-verified
request-by-request (method + path + body) for every command including the
ambiguous-name-prefix error path and the launch-blocker error path. See
`cli/README.md` for usage; `bin/argorant.js` for the implementation
(`cmdCampaigns` and helpers, kept on a dedicated flag reader `readFlags`
separate from the top-level `parseArgs` used by `count`/`search`/`reveal`/
`export`/`list`/`verify`).
