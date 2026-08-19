# argorant

Search, count, reveal, export, and verify B2B contacts from the Argorant
database — from your terminal, scripts, or coding agent. No install required.

```sh
npx argorant count "fintech CFOs in germany"
```

Company lookups, counts, and masked searches spend **zero contact credits on
an active plan**. Reveals and exports draw on your Argorant workspace
quota/credits — the same pool as the app, API, and MCP server.

## Authenticate

Create an API key at **app.argorant.com/profile** (API keys), then:

```sh
npx argorant login            # paste your ag_live_ key (stored in ~/.argorant)
```

Or set `ARGORANT_API_KEY=ag_live_…` in your environment — ideal for scripts,
CI, and agents.

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `login [key]` | Save an API key | — |
| `logout` | Forget the saved key and base (`~/.argorant/config.json`) | — |
| `whoami` | Account, scopes, daily quota | free |
| `count "<query>"` | Count matching contacts | free |
| `company <company.com> -n 5` | Count people at a company, split business-email coverage, preview masked roles | free |
| `search "<query>" -n 10` | Preview matches (masked identity, details redacted) | free |
| `sample <company.com> [-o sample.csv]` | Read a website and build 25 distinct, live-valid company leads from it | free sample |
| `reveal "<query>" -n 25` | Reveal full contact details (name, email, phone, LinkedIn) | quota |
| `export "<query>" -n 1000 -o leads.csv` | Verified CSV export, polled until ready | quota |
| `export status <job_id> [--batch]` | Status of an export you already created | free |
| `export download <job_id> [--batch] -o leads.csv` | Re-download a finished export | free |
| `list create --name "<n>" [filters]` | Save a reusable filtered list (server counts it) | free |
| `list status <id>` | A saved list's size and mode | free |
| `verify <email>` / `verify --file emails.csv -o out.csv` | Verify your own addresses (verification pool; recent re-checks free) | pool |
| `campaigns …` | Live outbound campaigns — **operator keys only**, see below | — |

Exports above 50,000 rows are created as a multi-chunk batch: the CLI polls
`export status --batch` for you and writes one file per chunk
(`leads-part1.csv`, `leads-part2.csv`, …). The batch id is printed so you can
re-download any time with `export download <batch_id> --batch`.

## Filters

Combine free text with structured filters:

```
--keywords --title --exclude-title --seniority --department --industry
--country --geography --state --city --company --domain
--has-phone --has-linkedin --has-email --verified-only
```

`--keywords` is the widest, most reliable filter (comma = OR) — prefer it over
`--industry`. `--country`/`--geography` accept regions (Europe, EMEA, DACH,
Nordics, APAC, LATAM, GCC…).

`--exclude-title` currently applies fully to `export` and `list create`; on
`count`/`search`/`reveal` it's a platform-side gap and the CLI prints a note
to stderr rather than silently dropping your filter.

Options: `-n/--limit`, `-o/--output`, `--json`, `-y/--yes`, `--base`,
`--grade <valid|valid-plus-catchall>`.

`--grade` is the one deliverability distinction exposed anywhere - you only
ever pay for deliverable contacts, and this picks between the strict set
(`valid`, the default) and the wider set that also includes catch-all
addresses. It's wired end to end on `reveal`/`export` but the platform
doesn't yet honor it (coming soon) - the CLI warns rather than pretending it
narrowed anything.

## Built for agents

```sh
export ARGORANT_API_KEY=ag_live_...
npx argorant count --keywords logistics --country "United States" --seniority vp --json
npx argorant company stripe.com --json
npx argorant reveal "heads of procurement" --country Germany -n 25 --json --yes
```

### Non-interactive behaviour — read this before scripting `reveal`/`export`

`reveal`, `export`, and `verify --file` ask for confirmation **only** when
stdin is a TTY and neither `-y/--yes` nor `--json` was passed. In CI, in a
pipe, or inside an agent loop there is **no prompt at all** — these commands
spend credits immediately. The prompt is a convenience for humans at a
terminal, never a safety net. Check your `-n` before you run them.

Related guardrails, so a mistake stays cheap:

- a non-numeric `-n` aborts instead of falling back to the default limit
- a value flag followed by another flag (`--title --base …`) aborts instead of
  swallowing it
- `export` verifies the output path is writable **before** creating the job,
  and prints an `export download <job_id>` recovery command if anything fails
  after the job was billed

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | generic error (bad usage, network, failed job) |
| `2` | not authenticated (no key, or the key was rejected) |
| `3` | forbidden — the key lacks the required scope |
| `4` | rate limit or daily quota reached |
| `5` | plan upgrade required (HTTP 402); the message carries the upgrade URL |

Exit `5` is deliberately distinct from `1`: an agent can tell "this account
needs a paid plan" apart from "something broke".

### Base URL and stored credentials

`argorant login` stores the key (and a non-default `--base`) in
`~/.argorant/config.json` at mode `0600`. An explicit `--base` on any later
command always wins over the stored one, `ARGORANT_API_BASE` overrides both,
and `argorant logout` removes the file.

## Campaigns — operator keys only

`argorant campaigns ...` drives live outbound campaigns end to end from the
terminal (create → copy → inboxes → leads → start), in about two minutes.
This group talks to a different, internal surface than everything above and
only works for an `ag_live_` key that belongs to an **owner/admin** account
and carries the `argorant:operator` scope — a normal customer key gets a
401/403, same as a browser session would without outbound access.

```sh
npx argorant campaigns create --name "Q3 CFO outreach" --brand argorant \
  --timezone America/New_York --window 08:00-17:00 --skip-weekends
npx argorant campaigns steps set "Q3 CFO outreach" --step 1 \
  --subject "Quick question" --body-file ./copy/step1.txt --approve
npx argorant campaigns inboxes attach "Q3 CFO outreach" --count 5 --pool argorant
npx argorant campaigns leads add "Q3 CFO outreach" --query "CFO" --industry fintech --country Germany
npx argorant campaigns start "Q3 CFO outreach"
```

| Command | What it does |
| --- | --- |
| `campaigns list [--brand <key>]` | Name, status, contacted, replies, reply rate |
| `campaigns create --name "<n>" [--brand] [--timezone] [--window HH:MM-HH:MM] [--skip-weekends]` | New native campaign |
| `campaigns steps set <campaign> --step <n> --subject "..." (--body-file <path> \| --body <text\|->) [--approve]` | Upsert one sequence step's copy. The CLI never writes copy for you. |
| `campaigns inboxes attach <campaign> --count <n> [--pool <brand>]` | Attach N healthy, unattached sending inboxes (explicit fleet change; prints exactly which ones) |
| `campaigns leads add <campaign> --csv <file>` | Import leads from a CSV (email + optional first_name/last_name/company/title/...) |
| `campaigns leads add <campaign> --query "..." [filters]` | Enroll leads straight from a server-side search (same filters as above) |
| `campaigns start <campaign>` / `pause <campaign>` | Start (auto-approves draft copy + campaign, background-schedules sends) / pause |
| `campaigns status <campaign>` | Setup completeness (steps/inboxes/leads) + launch blockers |

`<campaign>` accepts a raw id or an unambiguous case-insensitive name prefix;
an ambiguous prefix lists every match instead of guessing.

**Known gap:** `campaigns leads add --query` has no server-side row cap yet —
`-n/--limit` is accepted for a familiar CLI surface but not forwarded/honored
(it enrolls every valid match up to the platform's own cap). The CLI warns
when you pass it. See `cli/GODMODE-PLAN.md`.

## Releasing

`npm publish` runs `scripts/prepublish-guard.js` first, which refuses to
publish when the git working tree is dirty (so the tarball always matches a
real commit) or when the version in `package.json` already exists on npm (a
published version is never re-published or re-tagged). Bump the version,
commit, then publish.

Full docs: https://argorant.com/docs/cli
