#!/usr/bin/env node
"use strict";

// Argorant CLI — a thin, dependency-free wrapper over the Argorant REST API.
// Search, count, reveal, export, and verify B2B contacts from the terminal.
// Auth: an Argorant API key (ag_live_*) via `argorant login`, or ARGORANT_API_KEY.

const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { URL } = require("url");

const VERSION = require("../package.json").version;
const DEFAULT_BASE = process.env.ARGORANT_API_BASE || "https://argorant.com";
const CONFIG_DIR = path.join(os.homedir(), ".argorant");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// ---- tiny ANSI helpers (auto-disabled when not a TTY) ----
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const cyan = (s) => c("36", s);

function die(msg, code = 1) {
  process.stderr.write(red("error: ") + msg + "\n");
  process.exit(code);
}

// ---- config / key storage ----
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
function resolveKey() {
  return process.env.ARGORANT_API_KEY || loadConfig().apiKey || "";
}

// ---- arg parsing ----
// Flags that map to API filter params. Value flags take the next token.
const VALUE_FLAGS = {
  "--title": "title",
  "--exclude-title": "exclude_title",
  "--seniority": "seniority",
  "--department": "departments",
  "--departments": "departments",
  "--industry": "industry",
  "--country": "country",
  // --geography is an alias for --country; the API expands regions like
  // "Europe", "EMEA", "DACH", "APAC" into their member countries.
  "--geography": "country",
  "--region": "country",
  "--state": "state",
  "--city": "city",
  "--company": "company_name",
  "--domain": "company_domain",
};
// Boolean filter flags (presence => "true").
const BOOL_FLAGS = {
  "--has-phone": "has_phone",
  "--has-linkedin": "has_linkedin",
  "--has-email": "has_email",
};

function parseArgs(argv) {
  const out = { _: [], filters: {}, limit: null, output: null, file: null, column: null, json: false, yes: false, base: DEFAULT_BASE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "-n" || a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "-o" || a === "--output") out.output = argv[++i];
    else if (a === "-f" || a === "--file") out.file = argv[++i];
    else if (a === "--column") out.column = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a in VALUE_FLAGS) out.filters[VALUE_FLAGS[a]] = argv[++i];
    else if (a in BOOL_FLAGS) out.filters[BOOL_FLAGS[a]] = "true";
    else if (a.startsWith("--") && a.includes("=")) {
      const [k, v] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
      if (k in VALUE_FLAGS) out.filters[VALUE_FLAGS[k]] = v;
      else die(`unknown flag: ${k}`);
    } else if (a.startsWith("-") && a !== "-") {
      die(`unknown flag: ${a}`);
    } else {
      out._.push(a);
    }
  }
  // Free-text positional → q
  if (out._.length) out.filters.q = out._.join(" ");
  return out;
}

// ---- HTTP ----
function request(method, base, urlPath, { key, query, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlPath, base);
    } catch (e) {
      return reject(new Error(`bad URL: ${urlPath}`));
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
      }
    }
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Accept: "application/json", "User-Agent": `argorant-cli/${VERSION}` };
    if (key) headers["Authorization"] = `Bearer ${key}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      u,
      { method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            /* non-JSON (e.g. CSV download) */
          }
          resolve({ status: res.statusCode, json, raw, res });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function downloadTo(base, urlPath, key, dest) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      u,
      { method: "GET", headers: { Authorization: `Bearer ${key}`, "User-Agent": `argorant-cli/${VERSION}` } },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on("data", (d) => chunks.push(d));
          res.on("end", () => reject(new Error(`download failed (HTTP ${res.statusCode}): ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`)));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(dest)));
        file.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function need(res, what) {
  if (res.status === 401) die("not authenticated. Run `argorant login` or set ARGORANT_API_KEY.", 2);
  if (res.status === 403) die((res.json && res.json.detail) || `forbidden — your key lacks the scope for ${what}.`, 3);
  if (res.status === 429) die((res.json && res.json.detail) || "rate limit / daily quota reached.", 4);
  if (res.status >= 400) die((res.json && res.json.detail) || `${what} failed (HTTP ${res.status}).`);
  return res.json || {};
}

function requireKey() {
  const k = resolveKey();
  if (!k) die("no API key. Run `argorant login` or set ARGORANT_API_KEY.", 2);
  return k;
}

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // best-effort masking
      const onData = () => {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(question);
      };
      process.stdin.on("data", onData);
      rl.question(question, (ans) => {
        process.stdin.removeListener("data", onData);
        rl.close();
        process.stdout.write("\n");
        resolve(ans.trim());
      });
    } else {
      rl.question(question, (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    }
  });
}

// ---- commands ----
async function cmdLogin(args) {
  let key = args._[0];
  if (!key) key = await prompt("Paste your Argorant API key (ag_live_…): ", { hidden: true });
  if (!key) die("no key provided.");
  if (!/^ag_(live|test)_/.test(key)) process.stderr.write(dim("note: keys normally start with ag_live_ — continuing anyway.\n"));
  const res = await request("GET", args.base, "/api/mcp/account", { key });
  if (res.status === 401) die("that key was rejected (401). Double-check you copied the whole ag_live_ key.", 2);
  const acct = need(res, "login");
  saveConfig({ apiKey: key, base: args.base !== DEFAULT_BASE ? args.base : undefined });
  console.log(green("✓") + ` Logged in as ${bold(acct.email || "your account")} ${dim("(" + (acct.role || "member") + ")")}`);
  console.log(dim(`Key saved to ${CONFIG_PATH}`));
}

async function cmdWhoami(args) {
  const key = requireKey();
  const res = await request("GET", args.base, "/api/mcp/account", { key });
  const a = need(res, "whoami");
  if (args.json) return console.log(JSON.stringify(a, null, 2));
  console.log(`${bold("Account")}  ${a.email || "—"} ${dim("(" + (a.role || "member") + ")")}`);
  console.log(`${bold("Scopes")}   ${(a.scopes || []).join(", ") || "—"}`);
  const u = a.usage || {};
  const line = (label, k) => {
    const x = u[k];
    if (!x) return;
    const lim = x.daily_limit == null ? "unlimited" : x.daily_limit;
    console.log(`  ${label.padEnd(8)} ${x.used ?? 0}/${lim} today`);
  };
  if (!u.unlimited) {
    console.log(bold("Quota (today)"));
    line("count", "count");
    line("preview", "preview");
    line("reveal", "reveal");
    line("export", "export");
  } else {
    console.log(dim("Quota: unlimited"));
  }
}

async function cmdCount(args) {
  const key = requireKey();
  const res = await request("GET", args.base, "/api/mcp/people/count", { key, query: args.filters });
  const r = need(res, "count");
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(bold(Number(r.count).toLocaleString()) + dim(" matching contacts"));
}

async function cmdSearch(args) {
  const key = requireKey();
  const query = { ...args.filters, limit: args.limit || 5 };
  const res = await request("GET", args.base, "/api/mcp/people/preview", { key, query });
  const r = need(res, "search");
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(dim(`${Number(r.total).toLocaleString()} total · showing ${r.returned} (details redacted — use \`reveal\` or \`export\`)`));
  for (const p of r.results || []) {
    const who = [p.name, p.title].filter(Boolean).join(" · ");
    const where = [p.company || p.company_name, p.country].filter(Boolean).join(", ");
    console.log(`  ${bold(who || "—")}${where ? dim("  " + where) : ""}`);
  }
}

async function cmdReveal(args) {
  const key = requireKey();
  const limit = args.limit || 10;
  if (!args.yes && !args.json && process.stdin.isTTY) {
    const ans = await prompt(`Reveal up to ${bold(limit)} contacts? This uses your quota/credits. [y/N] `);
    if (!/^y(es)?$/i.test(ans)) return console.log(dim("aborted."));
  }
  const query = { ...args.filters, limit };
  const res = await request("GET", args.base, "/api/mcp/people/reveal", { key, query });
  const r = need(res, "reveal");
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(dim(`${Number(r.total).toLocaleString()} total · revealed ${r.returned}`));
  for (const p of r.results || []) {
    const who = [p.name, p.title].filter(Boolean).join(" · ");
    console.log(`  ${bold(who || "—")}`);
    const bits = [p.email && cyan(p.email), p.phone, p.linkedin_url, [p.company || p.company_name, p.country].filter(Boolean).join(", ")].filter(Boolean);
    if (bits.length) console.log("    " + bits.join(dim(" · ")));
  }
}

async function cmdExport(args) {
  const key = requireKey();
  const limit = args.limit || 1000;
  const dest = args.output || "argorant-leads.csv";
  if (!args.yes && !args.json && process.stdin.isTTY) {
    const ans = await prompt(`Export up to ${bold(limit)} verified contacts to ${bold(dest)}? Uses quota/credits. [y/N] `);
    if (!/^y(es)?$/i.test(ans)) return console.log(dim("aborted."));
  }
  const create = await request("POST", args.base, "/api/mcp/exports/create", { key, body: { limit, filters: args.filters } });
  const job = need(create, "export");
  const statusPath = job.status_api_path || (job.job_id ? `/api/mcp/exports/${job.job_id}` : null);
  if (!statusPath) {
    if (args.json) return console.log(JSON.stringify(job, null, 2));
    return console.log("Export queued. " + JSON.stringify(job));
  }
  if (!args.json) process.stdout.write(dim("Export queued — verifying & building CSV"));
  let downloadPath = job.download_api_path || null;
  const started = Date.now();
  // Poll until the job reports a terminal state.
  /* eslint-disable no-constant-condition */
  while (true) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = await request("GET", args.base, statusPath, { key });
    const s = need(st, "export status");
    const status = (s.status || "").toLowerCase();
    if (!args.json) process.stdout.write(".");
    if (s.download_api_path) downloadPath = s.download_api_path;
    if (["completed", "done", "ready", "succeeded"].includes(status) || s.downloadable) {
      downloadPath = downloadPath || `/api/mcp/exports/${job.job_id}/download`;
      break;
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) die(`\nexport ${status}.`);
    if (Date.now() - started > 1000 * 60 * 20) die("\nexport timed out after 20 minutes.");
  }
  if (!args.json) process.stdout.write("\n");
  if (!downloadPath) {
    if (args.json) return console.log(JSON.stringify(job, null, 2));
    return console.log("Export ready but no download path returned. Check `argorant export-list`.");
  }
  await downloadTo(args.base, downloadPath, key, dest);
  if (args.json) return console.log(JSON.stringify({ ok: true, file: dest, job_id: job.job_id }, null, 2));
  const rows = (() => {
    try {
      return fs.readFileSync(dest, "utf8").split("\n").filter(Boolean).length - 1;
    } catch {
      return null;
    }
  })();
  console.log(green("✓") + ` Saved ${rows != null ? bold(rows.toLocaleString()) + " rows → " : ""}${bold(dest)}`);
}

// ---- verify: external email verification (own lists) — the verification pool,
// separate from contact credits. 60-day re-checks are free. ----
const EMAIL_RE = /[^\s,;"']+@[^\s,;"']+\.[^\s,;"']+/;

async function cmdVerify(args) {
  const key = requireKey();
  if (args.file) return cmdVerifyFile(args, key);
  const email = (args._[0] || args.filters.q || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    die('usage: argorant verify <email>   |   argorant verify --file emails.csv [-o out.csv]');
  }
  const res = await request("POST", args.base, "/api/mcp/email/verify", { key, body: { email } });
  const r = need(res, "verify");
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  const tag = r.deliverable ? green(r.status) : dim(r.status);
  console.log(`  ${bold(email)}  →  ${tag}${r.deliverable ? "  " + green("✓ deliverable") : ""}`);
}

async function cmdVerifyFile(args, key) {
  let text;
  try { text = fs.readFileSync(args.file, "utf8"); } catch { die(`cannot read file: ${args.file}`); }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) die("file is empty");
  // Use the named/auto-detected email column if the file looks like a CSV with a
  // header; otherwise scan every line for an address.
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ""));
  const colIdx = args.column
    ? header.indexOf(args.column.toLowerCase())
    : header.findIndex((h) => h === "email" || h.includes("email"));
  let emails = [];
  if (colIdx >= 0) {
    for (let i = 1; i < lines.length; i++) {
      const m = (lines[i].split(",")[colIdx] || "").match(EMAIL_RE);
      if (m) emails.push(m[0].toLowerCase());
    }
  } else {
    for (const l of lines) { const m = l.match(EMAIL_RE); if (m) emails.push(m[0].toLowerCase()); }
  }
  emails = [...new Set(emails)];
  if (!emails.length) die("no email addresses found in file (try --column <name>)");
  const out = args.output || "argorant-verified.csv";
  if (!args.yes && !args.json && process.stdin.isTTY) {
    const ans = await prompt(`Verify ${bold(emails.length.toLocaleString())} emails? Fresh checks use your verification-check pool; addresses checked in the last 60 days are free. [y/N] `);
    if (!/^y(es)?$/i.test(ans)) return console.log(dim("aborted."));
  }
  const all = [];
  let charged = 0, cached = 0;
  for (let i = 0; i < emails.length; i += 500) {
    const chunk = emails.slice(i, i + 500);
    const res = await request("POST", args.base, "/api/mcp/email/verify/batch", { key, body: { emails: chunk } });
    const r = need(res, "verify");
    charged += r.checks_charged || 0;
    cached += r.cached || 0;
    for (const row of r.results || []) all.push(row);
    if (!args.json) process.stdout.write(`\r${dim(`verified ${Math.min(i + 500, emails.length).toLocaleString()}/${emails.length.toLocaleString()}`)}`);
  }
  if (!args.json) process.stdout.write("\n");
  if (args.json) return console.log(JSON.stringify({ ok: true, total: all.length, checks_charged: charged, cached, results: all }, null, 2));
  const csv = ["email,status,deliverable", ...all.map((r) => `${r.email},${r.status},${r.deliverable}`)].join("\n") + "\n";
  fs.writeFileSync(out, csv);
  const deliverable = all.filter((r) => r.deliverable).length;
  console.log(green("✓") + ` ${bold(all.length.toLocaleString())} verified → ${bold(out)}  ${dim(`(${deliverable.toLocaleString()} deliverable · ${charged.toLocaleString()} checks billed · ${cached.toLocaleString()} free cache hits)`)}`);
}

function help() {
  const p = bold("argorant");
  console.log(`
${bold("Argorant")} — verified B2B contacts from your terminal  ${dim("v" + VERSION)}

${bold("USAGE")}
  ${p} <command> "<query>" [filters]

${bold("COMMANDS")}
  ${cyan("login")} [key]                Save an API key (or set ARGORANT_API_KEY)
  ${cyan("whoami")}                     Account, scopes, and daily quota
  ${cyan("count")} "<query>"            Count matching contacts        ${dim("(free)")}
  ${cyan("search")} "<query>" -n 10     Preview matches, details redacted ${dim("(free)")}
  ${cyan("reveal")} "<query>" -n 25     Reveal full contact details    ${dim("(uses credits; live-verified, pay only for deliverable)")}
  ${cyan("export")} "<query>" -n 1000 -o leads.csv   Verified CSV export ${dim("(uses credits)")}
  ${cyan("verify")} <email>             Verify one of your own emails  ${dim("(verification pool)")}
  ${cyan("verify")} --file emails.csv -o out.csv      Bulk-verify your own list ${dim("(60-day re-checks free)")}

${bold("FILTERS")}
  --title <t>        --exclude-title <t>  --seniority <s>    --department <d>
  --industry <i>     --country <c>        --geography <r>    --state <s>
  --city <c>         --company <name>     --domain <domain>
  --has-phone        --has-linkedin       --has-email
  ${dim("--title is abbreviation-aware (CFO ↔ Chief Financial Officer).")}
  ${dim("--country / --geography accept regions: Europe, EMEA, DACH, Nordics, APAC, LATAM, GCC…")}

${bold("OPTIONS")}
  -n, --limit <n>    Max rows           -o, --output <file>   CSV path (export)
      --json         Raw JSON output    -y, --yes             Skip confirmations
      --base <url>   Override API base  (or ARGORANT_API_BASE)

${bold("EXAMPLES")}
  ${p} count "fintech CFOs in germany"
  ${p} search "heads of procurement" --country Germany -n 10
  ${p} export --industry fintech --title CFO --country Germany -n 500 -o cfos.csv
  ${p} verify ceo@stripe.com
  ${p} verify --file my-list.csv -o verified.csv

  Docs: ${cyan("https://argorant.com/docs/cli")}
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return help();
  if (cmd === "version" || cmd === "--version" || cmd === "-v") return console.log(VERSION);
  const args = parseArgs(argv.slice(1));
  // Allow a saved non-default base from login.
  if (args.base === DEFAULT_BASE) {
    const saved = loadConfig().base;
    if (saved && !process.env.ARGORANT_API_BASE) args.base = saved;
  }
  const table = {
    login: cmdLogin,
    whoami: cmdWhoami,
    count: cmdCount,
    search: cmdSearch,
    reveal: cmdReveal,
    export: cmdExport,
    verify: cmdVerify,
  };
  const fn = table[cmd];
  if (!fn) die(`unknown command: ${cmd}\nRun \`argorant help\` for usage.`);
  try {
    await fn(args);
  } catch (e) {
    die(e && e.message ? e.message : String(e));
  }
}

main();
