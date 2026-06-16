# argorant

Search, count, reveal, and export verified B2B contacts from the Argorant
database — from your terminal, scripts, or coding agent. No install required.

```sh
npx argorant count "fintech CFOs in germany"
```

Counts and searches are **free**. Reveals and exports draw on your Argorant
workspace quota/credits — the same pool as the app, API, and MCP server.

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
| `whoami` | Account, scopes, daily quota | free |
| `count "<query>"` | Count matching contacts | free |
| `search "<query>" -n 10` | Preview matches (details redacted) | free |
| `reveal "<query>" -n 25` | Reveal full contact details | quota |
| `export "<query>" -n 1000 -o leads.csv` | Verified CSV export, polled until ready | quota |

## Filters

Combine free text with structured filters:

```
--title --seniority --department --industry
--country --state --city --company --domain
--verify-status --has-phone --has-linkedin --has-email
```

Options: `-n/--limit`, `-o/--output`, `--json`, `-y/--yes`, `--base`.

## Built for agents

```sh
export ARGORANT_API_KEY=ag_live_...
npx argorant count --industry logistics --country "United States" --seniority vp --json
npx argorant reveal "heads of procurement" --country Germany -n 25 --json --yes
```

Full docs: https://argorant.com/docs/cli
