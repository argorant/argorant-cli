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
function warn(msg) {
  process.stderr.write(dim("note: ") + msg + "\n");
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
  // --keywords is the highest-recall door in the index (matches source keyword
  // tags + derived company tags, comma = OR). Measured against real segments it
  // beats --industry by 2-4x, so it leads the docs and examples below.
  "--keywords": "keywords",
  "--keyword": "keywords",
  "--country": "country",
  // --geography is an alias for --country; the API expands regions like
  // "Europe", "EMEA", "DACH", "APAC" into their member countries.
  "--geography": "country",
  "--region": "country",
  "--state": "state",
  "--city": "city",
  "--company": "company_name",
  "--domain": "company_domain",
  "--website": "website",
};
// Boolean filter flags (presence => "true"). --verified-only is positive intent
// only (deliverable contacts); there is deliberately NO flag to query invalid or
// any raw verification status — that is never exposed on any surface.
const BOOL_FLAGS = {
  "--has-phone": "has_phone",
  "--has-linkedin": "has_linkedin",
  "--has-email": "has_email",
  "--verified-only": "verified_only",
};

// ---- --grade: the only user-visible deliverability distinction is "valid"
// vs "valid + catch-all" - never raw verification status. Both values are
// currently platform-side no-ops (see GODMODE-PLAN.md / README); the flag is
// wired end-to-end here so it activates automatically once the platform
// supports narrowing, with no further CLI changes.
const GRADE_VALUES = new Set(["valid", "valid-plus-catchall"]);
function setGrade(out, v) {
  if (!GRADE_VALUES.has(v)) {
    die(`invalid --grade value: ${v} (expected "valid" or "valid-plus-catchall")`);
  }
  out.grade = v;
  out.gradeExplicit = true;
}

// --exclude-title is fully applied by `export` and `list create` today (the
// platform forwards it into the title-exclusion query on those two paths).
// `count`, `search`, and `reveal` go through a separate read path that does
// not yet apply it (see GODMODE-PLAN.md). Warn instead of silently dropping
// a filter the user asked for.
function warnExcludeTitleGap(filters) {
  if (filters.exclude_title) {
    warn(`--exclude-title is not applied by this command yet (platform-side gap) - it works with \`export\` and \`list create\`.`);
  }
}
function warnGradeGap(scope) {
  if (scope === "browse") warn(`--grade has no effect on count/search - grading only applies at reveal/export time.`);
  else if (scope === "reveal") warn(`--grade is coming soon for reveal - it currently always returns the platform's standard deliverable set.`);
  else if (scope === "export") warn(`--grade is coming soon for export - it currently always exports the platform's standard deliverable set (valid + catch-all).`);
}

// A value flag must be followed by an actual value. Silently swallowing the
// NEXT FLAG (`search "CFO" --title --base http://…` → title="--base") or a
// missing trailing value (→ undefined, dropped by request()) sends a request
// the user never asked for — against the wrong host, with the wrong filters.
// Fail loud instead. "-" stays legal: it is the documented stdin sentinel.
function flagValue(argv, i, flag) {
  const v = argv[i + 1];
  if (v === undefined) die(`${flag} needs a value.`);
  if (v.startsWith("-") && v !== "-" && !/^-\d/.test(v)) {
    die(`${flag} needs a value, but the next argument is another flag (${v}).`);
  }
  return v;
}
// -n/--limit drives billed row counts on reveal/export — a typo must never
// fall through to the default (a mistyped `-n` used to become a 1000-row
// billed export).
function parseLimit(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    die(`${flag} must be a positive whole number (got "${raw}").`);
  }
  return n;
}

function parseArgs(argv) {
  const out = { _: [], filters: {}, limit: null, output: null, file: null, column: null, json: false, yes: false, base: DEFAULT_BASE, baseExplicit: false, batch: false, name: null, includeExported: false, grade: "valid", gradeExplicit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "-n" || a === "--limit") out.limit = parseLimit(flagValue(argv, i++, a), a);
    else if (a === "-o" || a === "--output") out.output = flagValue(argv, i++, a);
    else if (a === "-f" || a === "--file") out.file = flagValue(argv, i++, a);
    else if (a === "--column") out.column = flagValue(argv, i++, a);
    else if (a === "--base") { out.base = flagValue(argv, i++, a); out.baseExplicit = true; }
    else if (a === "--name") out.name = flagValue(argv, i++, a);
    else if (a === "--include-exported") out.includeExported = true;
    else if (a === "--batch") out.batch = true;
    else if (a === "--grade") setGrade(out, flagValue(argv, i++, a));
    else if (a in VALUE_FLAGS) out.filters[VALUE_FLAGS[a]] = flagValue(argv, i++, a);
    else if (a in BOOL_FLAGS) out.filters[BOOL_FLAGS[a]] = "true";
    else if (a.startsWith("--") && a.includes("=")) {
      const [k, v] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
      if (k in VALUE_FLAGS) out.filters[VALUE_FLAGS[k]] = v;
      else if (k === "--grade") setGrade(out, v);
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

// `detail` is a plain string on most endpoints, a structured object on some
// (plan_required, campaign launch blockers, native-delivery readiness) and a
// LIST of validation errors on any FastAPI 422. All three have to render as
// something a human or an agent can read — never "[object Object]".
function detailMsg(detail) {
  if (detail == null) return null;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        if (d == null) return null;
        if (typeof d === "string") return d;
        const where = Array.isArray(d.loc) ? d.loc.filter((x) => x !== "body" && x !== "query").join(".") : null;
        const msg = d.msg || d.message || d.type || JSON.stringify(d);
        return where ? `${where}: ${msg}` : msg;
      })
      .filter(Boolean);
    return parts.length ? parts.join("; ") : JSON.stringify(detail);
  }
  if (typeof detail === "object") {
    // {error, message} is the platform's structured-error shape.
    if (detail.message) return String(detail.message);
    if (detail.detail) return detailMsg(detail.detail);
    if (detail.error) return String(detail.error);
  }
  return JSON.stringify(detail);
}
// Exit codes are part of the CLI's contract with agents/CI:
//   0 ok · 1 generic failure · 2 not authenticated · 3 forbidden (scope)
//   4 rate limit / daily quota · 5 plan upgrade required (402)
const EXIT = { OK: 0, ERROR: 1, AUTH: 2, FORBIDDEN: 3, RATE_LIMIT: 4, UPGRADE: 5 };

function need(res, what) {
  const detail = res.json && res.json.detail;
  if (res.status === 401) die("not authenticated. Run `argorant login` or set ARGORANT_API_KEY.", EXIT.AUTH);
  if (res.status === 402) {
    // Distinct from a hard error: nothing is broken, the plan just doesn't
    // include this. Agents branch on exit 5 to surface an upgrade, not a bug.
    const d = detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {};
    const msg = detailMsg(detail) || `${what} requires a paid Argorant plan.`;
    const url = d.upgrade_url || d.url || "https://argorant.com/pricing";
    die(`${msg}${msg.includes(url) ? "" : `\nUpgrade: ${url}`}`, EXIT.UPGRADE);
  }
  if (res.status === 403) die(detailMsg(detail) || `forbidden — your key lacks the scope for ${what}.`, EXIT.FORBIDDEN);
  if (res.status === 429) die(detailMsg(detail) || "rate limit / daily quota reached.", EXIT.RATE_LIMIT);
  if (res.status >= 400) die(detailMsg(detail) || `${what} failed (HTTP ${res.status}).`);
  return res.json || {};
}

// A paid job must never die on a path problem AFTER it was billed: check the
// destination is writable before anything is created server-side.
function ensureWritable(dest) {
  const resolved = path.resolve(dest);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) die(`output directory does not exist: ${dir}`);
  const existed = fs.existsSync(resolved);
  try {
    fs.closeSync(fs.openSync(resolved, existed ? "a" : "w"));
    if (!existed) fs.unlinkSync(resolved);
  } catch (e) {
    die(`cannot write to ${dest}: ${e.message}`);
  }
  return resolved;
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
  saveConfig({ apiKey: key, base: args.baseExplicit && args.base !== DEFAULT_BASE ? args.base : undefined });
  console.log(green("✓") + ` Logged in as ${bold(acct.email || "your account")} ${dim("(" + (acct.role || "member") + ")")}`);
  console.log(dim(`Key saved to ${CONFIG_PATH}`));
}

async function cmdLogout() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(dim(`Nothing to do — no saved credentials at ${CONFIG_PATH}.`));
  } else {
    try {
      fs.unlinkSync(CONFIG_PATH);
    } catch (e) {
      die(`could not remove ${CONFIG_PATH}: ${e.message}`);
    }
    console.log(green("✓") + ` Removed saved key and base from ${bold(CONFIG_PATH)}`);
  }
  if (process.env.ARGORANT_API_KEY) {
    warn("ARGORANT_API_KEY is still set in this environment and takes precedence — unset it too.");
  }
}

async function cmdWhoami(args) {
  const key = requireKey();
  const res = await request("GET", args.base, "/api/mcp/account", { key });
  const a = need(res, "whoami");
  if (args.json) return console.log(JSON.stringify(a, null, 2));
  console.log(`${bold("Account")}  ${a.email || "—"} ${dim("(" + (a.role || "member") + ")")}`);
  console.log(`${bold("Scopes")}   ${(a.scopes || []).join(", ") || "—"}`);
  const u = a.usage || {};
  // Keys/fields must match _mcp_usage_summary: actions are count_requests /
  // preview_rows / reveal_rows / export_rows and each entry carries
  // `used_today` (NOT `used`). Getting this wrong printed a bare header.
  const QUOTA_ROWS = [
    ["count", "count_requests"],
    ["preview", "preview_rows"],
    ["reveal", "reveal_rows"],
    ["export", "export_rows"],
    ["find", "find_email_requests"],
    ["verify", "verify_email_requests"],
  ];
  const render = (label, k) => {
    const x = u[k];
    if (!x || typeof x !== "object") return null;
    const lim = x.daily_limit == null ? "unlimited" : Number(x.daily_limit).toLocaleString();
    const used = Number(x.used_today ?? x.used ?? 0).toLocaleString();
    return `  ${label.padEnd(8)} ${used}/${lim} today`;
  };
  if (u.unlimited) {
    console.log(dim("Quota: unlimited"));
    return;
  }
  const lines = QUOTA_ROWS.map(([label, k]) => render(label, k)).filter(Boolean);
  // No recognizable quota map (older/newer server, or a shape we don't know):
  // print nothing rather than an empty "Quota (today)" header.
  if (!lines.length) return;
  console.log(bold("Quota (today)"));
  for (const l of lines) console.log(l);
}

async function cmdCount(args) {
  const key = requireKey();
  warnExcludeTitleGap(args.filters);
  if (args.gradeExplicit) warnGradeGap("browse");
  const res = await request("GET", args.base, "/api/mcp/people/count", { key, query: args.filters });
  const r = need(res, "count");
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(bold(Number(r.count).toLocaleString()) + dim(" matching contacts"));
}

async function cmdCompany(args) {
  const key = requireKey();
  const domain = String(args.filters.company_domain || args._[0] || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/, 1)[0]
    .toLowerCase();
  if (!domain || !domain.includes(".")) {
    die("usage: argorant company <company.com> [--title <role>] [-n 5] [--json]");
  }
  const query = {
    title: args.filters.title,
    seniority: args.filters.seniority,
    departments: args.filters.departments,
    country: args.filters.country,
    limit: args.limit || 5,
  };
  const res = await request(
    "GET",
    args.base,
    `/api/mcp/companies/${encodeURIComponent(domain)}/people`,
    { key, query }
  );
  const r = need(res, "company people lookup");
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  const company = r.company || {};
  const companyLabel = company.company_name || domain;
  console.log(`${bold(companyLabel)}  ${dim(domain)}`);
  console.log(`  ${bold(Number(r.people_count || 0).toLocaleString())} people in Argorant`);
  console.log(`  ${bold(Number(r.business_email_coverage_count || 0).toLocaleString())} with business-email coverage`);
  if (company.employee_count != null) {
    console.log(`  ${dim("Company-reported employee estimate: " + Number(company.employee_count).toLocaleString())}`);
  }
  if ((r.results || []).length) {
    console.log(dim(`  Masked role preview (${r.returned || r.results.length}):`));
    for (const person of r.results) {
      const who = [person.preview, person.title].filter(Boolean).join(" · ");
      const where = [person.country].filter(Boolean).join(", ");
      console.log(`    ${bold(who || "—")}${where ? dim("  " + where) : ""}`);
    }
  }
}

async function cmdSearch(args) {
  const key = requireKey();
  warnExcludeTitleGap(args.filters);
  if (args.gradeExplicit) warnGradeGap("browse");
  const query = { ...args.filters, limit: args.limit || 5 };
  const res = await request("GET", args.base, "/api/mcp/people/preview", { key, query });
  const r = need(res, "search");
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(dim(`${Number(r.total).toLocaleString()} total · showing ${r.returned} (details redacted — use \`reveal\` or \`export\`)`));
  for (const p of r.results || []) {
    // _redacted_preview returns the masked identity as `preview` (e.g. "A* P"),
    // never `name` — without this the row rendered as title-only.
    const who = [p.preview || p.name, p.title].filter(Boolean).join(" · ");
    const where = [p.company || p.company_name, p.country].filter(Boolean).join(", ");
    console.log(`  ${bold(who || "—")}${where ? dim("  " + where) : ""}`);
  }
}

async function cmdSample(args) {
  const key = requireKey();
  const website = (args.filters.website || args._[0] || args.filters.q || "").trim();
  if (!website) {
    die("usage: argorant sample <company.com> [--json] [-o sample.csv]");
  }
  if (args.output) ensureWritable(args.output);
  const create = await request("POST", args.base, "/api/onboarding/website-sample", {
    key,
    body: { website },
  });
  let job = need(create, "website sample");
  if (!job.job_id) die("website sample did not return a job id.");
  if (!args.json) {
    process.stdout.write(dim(`Building a company-first sample for ${job.domain || website}`));
  }
  const started = Date.now();
  let lastPhase = job.phase;
  while (!["done", "failed"].includes((job.status || "").toLowerCase())) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const status = await request("GET", args.base, `/api/onboarding/website-sample/${job.job_id}`, { key });
    job = need(status, "website sample status");
    if (!args.json && job.phase !== lastPhase) {
      const labels = {
        reading: "reading website",
        matching_companies: "matching companies",
        finding_buyers: "finding buyers",
        live_verifying: "live-verifying work emails",
      };
      process.stdout.write(`\n${dim("→ " + (labels[job.phase] || job.phase))}`);
      lastPhase = job.phase;
    } else if (!args.json) {
      process.stdout.write(".");
    }
    if (Date.now() - started > 1000 * 60 * 20) die("\nwebsite sample timed out after 20 minutes.");
  }
  if (!args.json) process.stdout.write("\n");
  if (job.status === "failed") die(job.error || "website sample failed.");
  if (args.output) {
    const quoteCsv = (value) => `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
    const columns = ["full_name", "title", "company", "company_domain", "email", "country", "verification"];
    const csv = [columns.join(",")]
      .concat((job.results || []).map((row) => columns.map((column) => quoteCsv(row[column])).join(",")))
      .join("\n") + "\n";
    fs.writeFileSync(args.output, csv, "utf8");
  }
  if (args.json) return console.log(JSON.stringify(job, null, 2));
  console.log(
    green("✓") + ` Your first ${bold(String((job.results || []).length))} of ` +
      `${bold(Number(job.total_companies || 0).toLocaleString())} matching companies`
  );
  for (const lead of job.results || []) {
    console.log(`  ${bold(lead.full_name || "—")} ${dim("· " + (lead.title || "—"))}`);
    console.log(`    ${(lead.company || "—")} ${dim("· " + (lead.company_domain || "—"))}`);
    console.log(`    ${cyan(lead.email || "—")} ${green("✓ Valid")}`);
  }
  if (args.output) console.log(green("✓") + ` Saved CSV → ${bold(args.output)}`);
  console.log(dim(`These 25 are the sample; the full pool contains ${Number(job.total_companies || 0).toLocaleString()} companies.`));
}

async function cmdReveal(args) {
  const key = requireKey();
  warnExcludeTitleGap(args.filters);
  if (args.gradeExplicit) warnGradeGap("reveal");
  const limit = args.limit || 10;
  // Confirmation is interactive-only by design: with --yes, --json, or a
  // non-TTY stdin (CI, agents, pipes) this spends credits with no prompt.
  if (!args.yes && !args.json && process.stdin.isTTY) {
    const ans = await prompt(`Reveal up to ${bold(limit)} contacts? This uses your quota/credits. [y/N] `);
    if (!/^y(es)?$/i.test(ans)) return console.log(dim("aborted."));
  }
  // Sent for forward-compatibility: the platform has no per-request grade
  // control on reveal yet (see GODMODE-PLAN.md), so this is a no-op today.
  const query = { ...args.filters, limit, grade: args.grade === "valid-plus-catchall" ? "valid_plus_catchall" : "valid" };
  const res = await request("GET", args.base, "/api/mcp/people/reveal", { key, query });
  const r = need(res, "reveal");
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(dim(`${Number(r.total).toLocaleString()} total · revealed ${r.returned}`));
  for (const p of r.results || []) {
    // _revealed_contact returns full_name / first_name / last_name — there is
    // no `name` key. The customer just paid for this row; print who it is.
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || p.name;
    const who = [name, p.title].filter(Boolean).join(" · ");
    console.log(`  ${bold(who || "—")}`);
    const bits = [p.email && cyan(p.email), p.phone, p.linkedin_url, [p.company || p.company_name, p.country].filter(Boolean).join(", ")].filter(Boolean);
    if (bits.length) console.log("    " + bits.join(dim(" · ")));
  }
}

const EXPORT_TERMINAL_OK = ["completed", "done", "ready", "succeeded"];
const EXPORT_TERMINAL_FAIL = ["failed", "error", "cancelled", "canceled"];

// Insert "-partN" before the extension: leads.csv → leads-part1.csv.
function partPath(dest, n) {
  const ext = path.extname(dest);
  return dest.slice(0, dest.length - ext.length) + `-part${n}` + (ext || ".csv");
}

// >50k rows come back as {type:"batch", batch_id, status_api_path:
// /api/mcp/export-batches/{id}} with NO job_id and NO download_api_path — the
// old code fell through to /api/mcp/exports/undefined/download, so large
// exports were simply impossible from the CLI. Poll the batch, then download
// each completed chunk.
async function pollExportBatch(args, key, statusPath, { quiet = false } = {}) {
  const started = Date.now();
  let lastDone = -1;
  for (;;) {
    const st = await request("GET", args.base, statusPath, { key });
    const b = need(st, "export batch status");
    const status = (b.status || "").toLowerCase();
    if (!quiet && b.completed_chunks !== lastDone) {
      lastDone = b.completed_chunks;
      process.stdout.write(`\r${dim(`chunks ${b.completed_chunks || 0}/${b.total_chunks || "?"} · ${b.verified_rows || 0} rows`)}`);
    } else if (!quiet) {
      process.stdout.write(".");
    }
    if (EXPORT_TERMINAL_FAIL.includes(status)) die(`\nexport batch ${status}${b.error_message ? `: ${b.error_message}` : "."}`);
    if (EXPORT_TERMINAL_OK.includes(status)) return b;
    if (Date.now() - started > 1000 * 60 * 60) die("\nexport batch timed out after 60 minutes.");
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function downloadBatchChunks(args, key, batch, dest) {
  const chunks = (batch.chunks || []).filter((c) => c.downloadable || EXPORT_TERMINAL_OK.includes(String(c.status || "").toLowerCase()));
  if (!chunks.length) die("export batch reported done but returned no downloadable chunks.");
  const files = [];
  let i = 0;
  for (const chunk of chunks) {
    i += 1;
    const target = chunks.length === 1 ? dest : partPath(dest, chunk.chunk_index != null ? chunk.chunk_index + 1 : i);
    const dl = chunk.download_api_path || `/api/mcp/exports/${chunk.job_id}/download`;
    await downloadTo(args.base, dl, key, target);
    files.push(target);
  }
  return files;
}

function countCsvRows(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length - 1;
  } catch {
    return null;
  }
}

// `argorant export status <id>` / `argorant export download <id> -o file`:
// a paid export must never be unrecoverable because the CLI died after the
// job was created (bad path, ctrl-c, dropped connection).
async function exportStatusCmd(args, key, id) {
  const isBatch = args.batch;
  const p = isBatch ? `/api/mcp/export-batches/${id}` : `/api/mcp/exports/${id}`;
  const res = await request("GET", args.base, p, { key });
  const s = need(res, "export status");
  if (args.json) return console.log(JSON.stringify(s, null, 2));
  if (isBatch) {
    console.log(`${bold("Batch #" + (s.batch_id ?? id))}  ${dim(s.status || "—")}`);
    console.log(`  ${s.completed_chunks || 0}/${s.total_chunks || 0} chunks · ${Number(s.verified_rows || 0).toLocaleString()} rows · ${s.progress_pct || 0}%`);
  } else {
    console.log(`${bold("Export #" + (s.job_id ?? id))}  ${dim(s.status || "—")}`);
    console.log(`  ${Number(s.verified_rows || 0).toLocaleString()}/${Number(s.total_rows || 0).toLocaleString()} rows · ${s.progress_pct || 0}%${s.downloadable ? green("  · ready to download") : ""}`);
  }
  if (s.error_message) console.log(red("  " + s.error_message));
  if (s.downloadable) console.log(dim(`  argorant export download ${id}${isBatch ? " --batch" : ""} -o leads.csv`));
}

async function exportDownloadCmd(args, key, id) {
  const dest = ensureWritable(args.output || "argorant-leads.csv");
  if (args.batch) {
    const res = await request("GET", args.base, `/api/mcp/export-batches/${id}`, { key });
    const b = need(res, "export batch status");
    if (!EXPORT_TERMINAL_OK.includes(String(b.status || "").toLowerCase())) {
      die(`export batch #${id} is ${b.status || "not ready"} — run \`argorant export status ${id} --batch\`.`);
    }
    const files = await downloadBatchChunks(args, key, b, dest);
    if (args.json) return console.log(JSON.stringify({ ok: true, batch_id: id, files }, null, 2));
    for (const f of files) console.log(green("✓") + ` ${bold(String(countCsvRows(f) ?? "?"))} rows → ${bold(f)}`);
    return;
  }
  const res = await request("GET", args.base, `/api/mcp/exports/${id}`, { key });
  const s = need(res, "export status");
  if (!s.downloadable && !s.download_api_path) {
    die(`export #${id} is ${s.status || "not ready"} — run \`argorant export status ${id}\`.`);
  }
  await downloadTo(args.base, s.download_api_path || `/api/mcp/exports/${id}/download`, key, dest);
  if (args.json) return console.log(JSON.stringify({ ok: true, file: dest, job_id: id }, null, 2));
  const rows = countCsvRows(dest);
  console.log(green("✓") + ` Saved ${rows != null ? bold(rows.toLocaleString()) + " rows → " : ""}${bold(dest)}`);
}

async function cmdExport(args) {
  const key = requireKey();
  // `export status <id>` / `export download <id>` — recovery subcommands, no
  // job is created and nothing is billed.
  const sub = (args._[0] || "").toLowerCase();
  if (sub === "status" || sub === "download") {
    const id = args._[1];
    if (!id || !/^\d+$/.test(String(id))) die(`usage: argorant export ${sub} <job_id> [--batch]${sub === "download" ? " [-o file.csv]" : ""}   (job id must be a number)`);
    return sub === "status" ? exportStatusCmd(args, key, id) : exportDownloadCmd(args, key, id);
  }
  if (args.gradeExplicit) warnGradeGap("export");
  const limit = args.limit || 1000;
  // Validate the destination BEFORE creating the job: the old order billed the
  // export and then died on ENOENT, with no way to fetch the CSV again.
  const dest = ensureWritable(args.output || "argorant-leads.csv");
  // Confirmation is interactive-only by design: with --yes, --json, or a
  // non-TTY stdin (CI, agents, pipes) this spends credits with no prompt.
  if (!args.yes && !args.json && process.stdin.isTTY) {
    const ans = await prompt(`Export up to ${bold(limit)} verified contacts to ${bold(dest)}? Uses quota/credits. [y/N] `);
    if (!/^y(es)?$/i.test(ans)) return console.log(dim("aborted."));
  }
  // Match the MCP/app defaults so the CLI yields the same rows: business email
  // present by default, and skip rows already exported (override with
  // --include-exported). Verification stays live at export time - only deliverable
  // rows are billed; no verification-status filter is exposed.
  const exportFilters = { ...args.filters };
  if (exportFilters.has_email === undefined) exportFilters.has_email = "true";
  // `grades` is sent for forward-compatibility: the platform's MCP export
  // endpoint has no per-request grade control yet (see GODMODE-PLAN.md), so
  // this is a no-op today and every export includes the standard valid +
  // catch-all set regardless of --grade.
  const grades = args.grade === "valid-plus-catchall" ? ["valid", "catch_all"] : ["valid"];
  const create = await request("POST", args.base, "/api/mcp/exports/create", {
    key,
    body: { limit, filters: exportFilters, exclude_previously_exported: !args.includeExported, grades },
  });
  const job = need(create, "export");
  // >EXPORT_MAX_ROWS (50k) → a multi-chunk batch, a different status endpoint
  // and one download per chunk.
  if (job.type === "batch" || (job.batch_id && !job.job_id)) {
    const batchPath = job.status_api_path || `/api/mcp/export-batches/${job.batch_id}`;
    if (!args.json) {
      process.stdout.write(
        dim(`Large export queued as batch #${job.batch_id} — ${job.total_chunks || "?"} chunk(s) of up to ${Number(job.chunk_size || 0).toLocaleString()} rows\n`)
      );
    }
    const batch = await pollExportBatch(args, key, batchPath, { quiet: !!args.json });
    if (!args.json) process.stdout.write("\n");
    const files = await downloadBatchChunks(args, key, batch, dest);
    if (args.json) return console.log(JSON.stringify({ ok: true, batch_id: job.batch_id, files }, null, 2));
    for (const f of files) console.log(green("✓") + ` ${bold(String(countCsvRows(f) ?? "?"))} rows → ${bold(f)}`);
    if (files.length > 1) console.log(dim(`Re-download any time:  argorant export download ${job.batch_id} --batch -o ${dest}`));
    return;
  }
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
    if (EXPORT_TERMINAL_FAIL.includes(status)) die(`\nexport ${status}${s.error_message ? `: ${s.error_message}` : "."}`);
    if (Date.now() - started > 1000 * 60 * 20) {
      die(`\nexport timed out after 20 minutes. It is still running server-side — check with \`argorant export status ${job.job_id}\`.`);
    }
  }
  if (!args.json) process.stdout.write("\n");
  if (!downloadPath) {
    if (args.json) return console.log(JSON.stringify(job, null, 2));
    return console.log(`Export ready but no download path returned yet. Retry with \`argorant export download ${job.job_id} -o ${dest}\`.`);
  }
  try {
    await downloadTo(args.base, downloadPath, key, dest);
  } catch (e) {
    // The job is already paid for — always tell the user how to get it back.
    die(`${e.message}\nThe export itself completed. Retry the download with \`argorant export download ${job.job_id} -o ${dest}\`.`);
  }
  if (args.json) return console.log(JSON.stringify({ ok: true, file: dest, job_id: job.job_id }, null, 2));
  const rows = countCsvRows(dest);
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
  const out = ensureWritable(args.output || "argorant-verified.csv");
  // Interactive-only by design — see reveal/export.
  if (!args.yes && !args.json && process.stdin.isTTY) {
    const ans = await prompt(`Verify ${bold(emails.length.toLocaleString())} emails? You're billed only for fresh checks from your verification-check pool; recent re-checks are free. [y/N] `);
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
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const csv = ["email,status,deliverable", ...all.map((r) => [r.email, r.status, r.deliverable].map(q).join(","))].join("\n") + "\n";
  fs.writeFileSync(out, csv);
  const deliverable = all.filter((r) => r.deliverable).length;
  console.log(green("✓") + ` ${bold(all.length.toLocaleString())} verified → ${bold(out)}  ${dim(`(${deliverable.toLocaleString()} deliverable · ${charged.toLocaleString()} checks billed · ${cached.toLocaleString()} free)`)}`);
}

// ---- list: save & inspect reusable lead lists (parity with MCP/app). Creating a
// filtered list is free and does NOT reveal contacts — the server counts the
// matches itself, so the list reports its real size right away. ----
async function cmdList(args) {
  const key = requireKey();
  const sub = (args._[0] || "").toLowerCase();
  if (sub === "create") {
    const name = (args.name || "").trim();
    if (!name) die('usage: argorant list create --name "My list" [filters]   (e.g. --title CEO --country Germany)');
    delete args.filters.q; // the "create" subcommand word leaks into q via parseArgs
    const body = { name, filters: args.filters, record_type: "person", selection_mode: "filtered" };
    const res = await request("POST", args.base, "/api/mcp/lists/create", { key, body });
    const r = need(res, "list create");
    if (args.json) return console.log(JSON.stringify(r, null, 2));
    const total = Number(r.snapshot_total || 0);
    console.log(green("✓") + ` Created list ${bold("#" + r.list_id)} ${dim("“" + r.name + "”")} — ${bold(total.toLocaleString())} matching contacts`);
    console.log(dim(`Export it with:  argorant export ${Object.entries(args.filters).filter(([, v]) => v).map(([k, v]) => `--${k.replace(/_/g, "-")} ${/\s/.test(String(v)) ? `"${v}"` : v}`).join(" ")} -o leads.csv`));
    return;
  }
  if (sub === "status" || sub === "show" || sub === "get") {
    const id = args._[1] || args.name;
    if (!id) die("usage: argorant list status <list_id>");
    // Validate locally: the API path param is an int, so anything else came
    // back as a FastAPI 422 whose detail is an array — a useless error for a
    // plain typo.
    if (!/^\d+$/.test(String(id).trim())) die(`list id must be a number (got "${id}").`);
    const res = await request("GET", args.base, `/api/mcp/lists/${encodeURIComponent(String(id).trim())}`, { key });
    const r = need(res, "list status");
    if (args.json) return console.log(JSON.stringify(r, null, 2));
    const total = Number(r.snapshot_total ?? r.item_count ?? 0);
    console.log(`${bold("List #" + (r.list_id ?? id))}  ${dim("“" + (r.name || "—") + "”")}`);
    console.log(`  ${bold(total.toLocaleString())} contacts · ${dim((r.selection_mode || "filtered") + " · " + (r.record_type || "person"))}`);
    return;
  }
  die("usage: argorant list create --name \"…\" [filters]   |   argorant list status <id>");
}

// =============================================================================
// campaigns: god-mode native outbound campaign control from the terminal.
//
// OPERATOR KEYS ONLY. Every command above talks to /api/mcp/* — the
// customer-facing contact-data API, gated by plan scopes. Everything below
// talks to /api/sequencer/* — the internal Argorant Sequencer that runs live
// outbound sends. It authenticates via the SAME ag_live_ Bearer key, but only
// works for a key that (a) belongs to an owner/admin account and (b) carries
// the `argorant:operator` scope (see cli/GODMODE-PLAN.md). Any other key gets
// a 401/403 from the API, same as a browser session would without outbound
// access.
//
// Kept on its own tiny flag reader (readFlags) instead of the top-level
// parseArgs — these subcommands have their own vocabulary (--step, --subject,
// --count, --pool, --csv, ...) that would otherwise collide with, or be
// rejected by, the generic filter-flag parser used for search/reveal/export.
// =============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Filter flags for `campaigns leads add --query ...` — the same names/mapping
// as the top-level VALUE_FLAGS/BOOL_FLAGS (minus the ones the sequencer's
// filter-enroll endpoint doesn't accept, e.g. --verified-only), plus --query
// as an explicit alias for free-text `q` (clearer than a bare positional in a
// command that already takes a campaign name/id as its first positional).
const CAMPAIGN_FILTER_VALUE_FLAGS = {
  "--query": "q",
  "--title": "title",
  "--exclude-title": "exclude_title",
  "--seniority": "seniority",
  "--department": "departments",
  "--departments": "departments",
  "--industry": "industry",
  "--keywords": "keywords",
  "--keyword": "keywords",
  "--country": "country",
  "--geography": "country",
  "--region": "country",
  "--state": "state",
  "--city": "city",
  "--company": "company_name",
  "--domain": "company_domain",
};
const CAMPAIGN_FILTER_BOOL_FLAGS = {
  "--has-phone": "has_phone",
  "--has-linkedin": "has_linkedin",
  "--has-email": "has_email",
};

// Minimal flag reader shared by every `campaigns` subcommand: pulls out the
// universal --json/--yes/--base plus whatever value/bool flags the caller
// declares, leaves everything else as positionals, and dies on anything that
// looks like a flag but isn't recognized (same "fail loud" behavior as the
// top-level parser).
function readFlags(argv, valueFlags = {}, boolFlags = {}) {
  const out = { _: [], json: false, yes: false, base: DEFAULT_BASE, baseExplicit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--base") { out.base = flagValue(argv, i++, a); out.baseExplicit = true; }
    else if (a in valueFlags) out[valueFlags[a]] = flagValue(argv, i++, a);
    else if (a in boolFlags) out[boolFlags[a]] = true;
    else if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      const k = a.slice(0, eq), v = a.slice(eq + 1);
      if (k in valueFlags) out[valueFlags[k]] = v;
      else if (k in boolFlags) out[boolFlags[k]] = v !== "false";
      else die(`unknown flag: ${k}`);
    } else if (a.startsWith("-") && a !== "-") die(`unknown flag: ${a}`);
    else out._.push(a);
  }
  applySavedBase(out);
  return out;
}

// A saved base from `argorant login --base …` only applies when the caller did
// NOT pass --base. Inferring "no flag given" from the VALUE (=== DEFAULT_BASE)
// meant `--base https://argorant.com` was silently ignored after a staging
// login — requests went to the wrong host with no indication.
function applySavedBase(args) {
  if (args.baseExplicit || process.env.ARGORANT_API_BASE) return args;
  const saved = loadConfig().base;
  if (saved) args.base = saved;
  return args;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function fetchCampaigns(base, key, { brand, includeCounts = true } = {}) {
  const query = { include_counts: includeCounts ? "true" : "false", limit: "500" };
  if (brand) query.brand = brand;
  const res = await request("GET", base, "/api/sequencer/campaigns", { key, query });
  const r = need(res, "campaigns list");
  return r.campaigns || [];
}

// <campaign> accepts a raw id (uuid) or an unambiguous case-insensitive name
// prefix. Errors listing every match when the prefix is ambiguous.
async function resolveCampaign(base, key, identifier) {
  if (!identifier) die("campaign id or name is required.");
  if (UUID_RE.test(identifier)) return identifier;
  const campaigns = await fetchCampaigns(base, key, { includeCounts: false });
  const needle = identifier.trim().toLowerCase();
  const matches = campaigns.filter((c) => String(c.name || "").toLowerCase().startsWith(needle));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) {
    die(`no campaign matching "${identifier}". Run \`argorant campaigns list\` to see names.`);
  }
  die(
    `"${identifier}" matches ${matches.length} campaigns — be more specific:\n` +
      matches.map((c) => `  ${c.id}  ${c.name}`).join("\n")
  );
}

async function campaignsList(argv) {
  const key = requireKey();
  const args = readFlags(argv, { "--brand": "brand" });
  const campaigns = await fetchCampaigns(args.base, key, { brand: args.brand, includeCounts: true });
  if (args.json) return console.log(JSON.stringify(campaigns, null, 2));
  if (!campaigns.length) {
    return console.log(dim('No campaigns yet. Create one with `argorant campaigns create --name "..."`.'));
  }
  for (const c of campaigns) {
    const sent = Number(c.sent_count || 0);
    const replied = Number(c.replied_count || 0);
    const rate = sent > 0 ? `${((replied / sent) * 100).toFixed(1)}%` : "—";
    console.log(`${bold(c.name || "—")}  ${dim(c.id)}`);
    console.log(
      `  ${c.status}` +
        dim("  ·  contacted ") + sent.toLocaleString() +
        dim("  ·  replies ") + replied.toLocaleString() +
        dim("  ·  reply rate ") + rate
    );
  }
}

async function campaignsCreate(argv) {
  const key = requireKey();
  const args = readFlags(
    argv,
    { "--name": "name", "--brand": "brand", "--timezone": "timezone", "--window": "window" },
    { "--skip-weekends": "skipWeekends", "--no-skip-weekends": "noSkipWeekends" }
  );
  const name = (args.name || "").trim();
  if (!name) {
    die(
      'usage: argorant campaigns create --name "<name>" [--brand <key>] [--timezone <tz>] ' +
        "[--window HH:MM-HH:MM] [--skip-weekends | --no-skip-weekends]"
    );
  }
  // lead_source defaults to "argorant_campaign" server-side, which requires a
  // source_outbound_campaign_id this command doesn't collect. CLI-created
  // campaigns add leads afterwards via `campaigns leads add`, so force "manual"
  // — it's a plain attribute on the campaign row, independent of how leads
  // actually get imported later.
  const body = { name, lead_source: "manual" };
  if (args.brand) body.product_key = args.brand;
  if (args.timezone) body.default_timezone = args.timezone;
  if (args.window) {
    const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(args.window);
    if (!m) die("--window must look like 08:00-17:00");
    body.sending_window_start = m[1];
    body.sending_window_end = m[2];
  }
  if (args.skipWeekends) body.skip_weekends = true;
  if (args.noSkipWeekends) body.skip_weekends = false;
  const res = await request("POST", args.base, "/api/sequencer/campaigns", { key, body });
  const r = need(res, "campaigns create");
  const c = r.campaign || {};
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(green("✓") + ` Created campaign ${bold(c.name)} ${dim(c.id)}`);
  console.log(
    dim(
      `  ${c.status} · ${c.default_timezone} · ${c.sending_window_start}–${c.sending_window_end} · skip weekends: ${c.skip_weekends}`
    )
  );
  console.log(dim(`Next:  argorant campaigns steps set ${c.id} --step 1 --subject "..." --body-file ./copy.txt`));
}

async function campaignsSteps(argv) {
  const sub = argv[0];
  if (sub !== "set") {
    die(
      'usage: argorant campaigns steps set <campaign> --step <n> --subject "..." ' +
        "(--body-file <path> | --body <text|->) [--approve]"
    );
  }
  const key = requireKey();
  const args = readFlags(
    argv.slice(1),
    { "--step": "step", "--subject": "subject", "--body-file": "bodyFile", "--body": "body" },
    { "--approve": "approve" }
  );
  const identifier = args._[0];
  if (!identifier) die("usage: argorant campaigns steps set <campaign> --step <n> ...");
  const stepNumber = parseInt(args.step, 10);
  if (!stepNumber || stepNumber < 1) die("--step must be a positive integer (>= 1)");
  const subject = (args.subject || "").trim();
  if (!subject) die("--subject is required");
  let body;
  if (args.bodyFile) {
    try {
      body = fs.readFileSync(args.bodyFile, "utf8");
    } catch {
      die(`cannot read file: ${args.bodyFile}`);
    }
  } else if (args.body !== undefined) {
    body = args.body === "-" ? await readStdin() : args.body;
  } else {
    die("provide --body-file <path>, or --body <text> (--body - reads the body from stdin)");
  }
  body = (body || "").trim();
  if (!body) die("body is empty");
  // The CLI never generates copy — the operator/agent writes it; this command
  // only upserts what it's given.
  const campaignId = await resolveCampaign(args.base, key, identifier);
  const stepBody = { step_number: stepNumber, subject, body, copy_status: args.approve ? "approved" : "draft" };
  const res = await request("POST", args.base, `/api/sequencer/campaigns/${campaignId}/steps`, { key, body: stepBody });
  const r = need(res, "campaigns steps set");
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  const s = r.step || {};
  console.log(green("✓") + ` Step ${bold(s.step_number)} saved (${s.copy_status})` + dim(`  “${subject}”`));
}

async function campaignsInboxes(argv) {
  const sub = argv[0];
  if (sub !== "attach") die("usage: argorant campaigns inboxes attach <campaign> --count <n> [--pool <brand>]");
  const key = requireKey();
  const args = readFlags(argv.slice(1), { "--count": "count", "--pool": "pool" });
  const identifier = args._[0];
  if (!identifier) die("usage: argorant campaigns inboxes attach <campaign> --count <n> [--pool <brand>]");
  const count = parseInt(args.count, 10);
  if (!count || count < 1) die("--count must be a positive integer");
  const campaignId = await resolveCampaign(args.base, key, identifier);

  // Fleet changes only ever happen via this explicit command — never
  // implicitly from create/start. Exclude whatever's already attached to THIS
  // campaign (an inbox can serve multiple campaigns; "unattached" is relative
  // to this one), then page through the healthy/usable pool for candidates.
  const attachedRes = await request("GET", args.base, `/api/sequencer/campaigns/${campaignId}/inboxes`, { key });
  const already = need(attachedRes, "campaigns inboxes attach").inboxes || [];
  const attachedIds = new Set(already.map((i) => String(i.id)));

  const candidates = [];
  const seen = new Set();
  let page = 1;
  for (;;) {
    const query = { status: "usable", page_size: "500", page: String(page) };
    if (args.pool) query.brand = args.pool;
    const res = await request("GET", args.base, "/api/sequencer/inboxes", { key, query });
    const r = need(res, "campaigns inboxes attach");
    const rows = r.inboxes || [];
    for (const row of rows) {
      const id = String(row.id);
      if (attachedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      candidates.push(row);
      if (candidates.length >= count) break;
    }
    const pg = r.pagination || {};
    if (candidates.length >= count || !pg.has_next || !rows.length) break;
    page += 1;
  }
  if (!candidates.length) {
    die(`no healthy, unattached inboxes found${args.pool ? ` in pool "${args.pool}"` : ""}.`);
  }
  const chosen = candidates.slice(0, count);
  const emails = chosen.map((i) => i.email);
  const attachRes = await request("POST", args.base, `/api/sequencer/campaigns/${campaignId}/inboxes`, {
    key,
    body: { inbox_emails: emails },
  });
  const r = need(attachRes, "campaigns inboxes attach");
  if (args.json) return console.log(JSON.stringify({ requested: count, attached: emails, result: r }, null, 2));
  console.log(
    green("✓") +
      ` Attached ${bold(r.attached ?? emails.length)} inbox(es)` +
      (chosen.length < count ? dim(` (only ${chosen.length} healthy unattached inboxes were available)`) : "") +
      ":"
  );
  for (const email of emails) console.log(`  ${email}`);
  if (r.missing && r.missing.length) console.log(dim(`  not found: ${r.missing.join(", ")}`));
}

async function campaignsLeads(argv) {
  const sub = argv[0];
  if (sub !== "add") {
    die(
      'usage: argorant campaigns leads add <campaign> --csv <file>\n' +
        '   or: argorant campaigns leads add <campaign> --query "..." [filters] -n <n>'
    );
  }
  const key = requireKey();
  const valueFlags = { ...CAMPAIGN_FILTER_VALUE_FLAGS, "--csv": "csv", "-n": "limit", "--limit": "limit" };
  const args = readFlags(argv.slice(1), valueFlags, CAMPAIGN_FILTER_BOOL_FLAGS);
  const identifier = args._[0];
  if (!identifier) {
    die(
      'usage: argorant campaigns leads add <campaign> --csv <file>\n' +
        '   or: argorant campaigns leads add <campaign> --query "..." [filters] -n <n>'
    );
  }
  const campaignId = await resolveCampaign(args.base, key, identifier);
  const body = {};
  if (args.csv) {
    let text;
    try {
      text = fs.readFileSync(args.csv, "utf8");
    } catch {
      die(`cannot read file: ${args.csv}`);
    }
    if (!text.trim()) die(`file is empty: ${args.csv}`);
    body.csv_text = text;
  } else {
    const filters = {};
    for (const field of Object.values(CAMPAIGN_FILTER_VALUE_FLAGS)) if (args[field]) filters[field] = args[field];
    for (const field of Object.values(CAMPAIGN_FILTER_BOOL_FLAGS)) if (args[field]) filters[field] = "true";
    if (!Object.keys(filters).length) {
      die(
        'provide --csv <file>, or at least one filter: --query "..." --title --country --industry ' +
          "--seniority --department --state --city --company --domain --has-phone --has-linkedin --has-email"
      );
    }
    // GAP (see GODMODE-PLAN.md): the sequencer's filter-enroll endpoint has no
    // per-request row cap — it enrolls every valid match up to its own
    // server-side limit (currently 50,000). -n/--limit is accepted here for a
    // familiar CLI surface but is NOT forwarded/honored; warn rather than
    // silently ignoring a flag the caller explicitly set.
    if (args.limit) {
      warn("-n/--limit is not honored by campaign lead enrollment yet (platform-side gap, see GODMODE-PLAN.md) — it enrolls every valid match.");
    }
    body.filters = filters;
  }
  const res = await request("POST", args.base, `/api/sequencer/campaigns/${campaignId}/leads/import`, { key, body });
  const r = need(res, "campaigns leads add");
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(
    green("✓") +
      ` ${bold(r.inserted || 0)} lead(s) added` +
      (r.duplicates_skipped ? dim(` (${r.duplicates_skipped} duplicate already in campaign)`) : "")
  );
  if (r.queued_for_verification) {
    console.log(dim(`  ${r.queued_for_verification} queued for verification — will join once confirmed deliverable`));
  }
  if (r.skipped_not_valid) console.log(dim(`  ${r.skipped_not_valid} skipped (not deliverable)`));
  if (r.invalid_email_rows) console.log(dim(`  ${r.invalid_email_rows} row(s) had no usable email`));
}

async function campaignsSetStatus(argv, status, verb) {
  const key = requireKey();
  const args = readFlags(argv, {});
  const identifier = args._[0];
  if (!identifier) die(`usage: argorant campaigns ${verb} <campaign>`);
  const campaignId = await resolveCampaign(args.base, key, identifier);
  const res = await request("PATCH", args.base, `/api/sequencer/campaigns/${campaignId}`, { key, body: { status } });
  if (res.status === 400 && res.json && res.json.detail && typeof res.json.detail === "object") {
    const d = res.json.detail;
    const blockers = d.blockers || [];
    die(
      `cannot ${verb} campaign: ${d.message || "blocked"}` +
        (blockers.length ? "\n" + blockers.map((b) => `  - ${b}`).join("\n") : "")
    );
  }
  const r = need(res, `campaigns ${verb}`);
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  const c = r.campaign || {};
  console.log(green("✓") + ` Campaign ${bold(c.name || campaignId)} is now ${bold(c.status || status)}`);
}

async function campaignsStatus(argv) {
  const key = requireKey();
  const args = readFlags(argv, {});
  const identifier = args._[0];
  if (!identifier) die("usage: argorant campaigns status <campaign>");
  const campaignId = await resolveCampaign(args.base, key, identifier);
  const res = await request("GET", args.base, `/api/sequencer/campaigns/${campaignId}`, { key });
  const r = need(res, "campaigns status");
  const c = r.campaign || {};
  if (args.json) return console.log(JSON.stringify(c, null, 2));
  const stepsOk = Number(c.approved_step_count || 0) > 0;
  const inboxesOk = Number(c.inbox_count || 0) > 0;
  const leadsOk = Number(c.queued_count || 0) > 0 || Number(c.lead_count || 0) > 0;
  const mark = (ok) => (ok ? green("✓") : red("✗"));
  console.log(`${bold(c.name || "—")}  ${dim(c.id)}  ${dim(c.status)}`);
  console.log(`  ${mark(stepsOk)} steps approved      ${dim(`${c.approved_step_count || 0}/${c.step_count || 0}`)}`);
  console.log(`  ${mark(inboxesOk)} inboxes attached    ${dim(String(c.inbox_count || 0))}`);
  console.log(
    `  ${mark(leadsOk)} leads queued        ${dim(`${c.queued_count || 0} queued / ${c.lead_count || 0} total`)}`
  );
  const blockers = c.launch_blockers || [];
  if (blockers.length) {
    console.log(bold("\nLaunch blockers:"));
    for (const b of blockers) console.log(`  - ${b}`);
  } else {
    console.log(green("\n✓ Ready to launch") + dim(`  —  argorant campaigns start ${c.id}`));
  }
}

function campaignsHelp() {
  const p = bold("argorant campaigns");
  console.log(`
${bold("Argorant Campaigns")} — god-mode outbound campaign control  ${dim("(operator keys only)")}

Drives the internal Argorant Sequencer (${dim("/api/sequencer/*")}) — a live campaign
in about two minutes from the terminal. Requires an ag_live_ key belonging to
an owner/admin account with the ${bold("argorant:operator")} scope; any other key gets
a 401/403, same as it would in a browser without outbound access.

${bold("USAGE")}
  ${p} list [--brand <key>]
  ${p} create --name "<name>" [--brand <key>] [--timezone <tz>] [--window HH:MM-HH:MM] [--skip-weekends]
  ${p} steps set <campaign> --step <n> --subject "..." (--body-file <path> | --body <text|->) [--approve]
  ${p} inboxes attach <campaign> --count <n> [--pool <brand>]
  ${p} leads add <campaign> --csv <file>
  ${p} leads add <campaign> --query "..." [filters]
  ${p} start <campaign>
  ${p} pause <campaign>
  ${p} status <campaign>

${dim("<campaign> accepts a raw id or an unambiguous case-insensitive name prefix.")}
${dim("The CLI never writes copy for you — steps set only upserts what you give it.")}

${bold("EXAMPLE — live in two minutes")}
  ${p} create --name "Q3 CFO outreach" --brand argorant --timezone America/New_York --window 08:00-17:00 --skip-weekends
  ${p} steps set "Q3 CFO outreach" --step 1 --subject "Quick question" --body-file ./copy/step1.txt --approve
  ${p} inboxes attach "Q3 CFO outreach" --count 5 --pool argorant
  ${p} leads add "Q3 CFO outreach" --query "CFO" --industry fintech --country Germany
  ${p} start "Q3 CFO outreach"

${bold("OPTIONS")}
  --json         Raw JSON output      --base <url>   Override API base

  Docs: ${cyan("https://argorant.com/docs/cli")}   ·   Gap notes: cli/GODMODE-PLAN.md
`);
}

async function cmdCampaigns(argv) {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") return campaignsHelp();
  const rest = argv.slice(1);
  const table = {
    list: campaignsList,
    create: campaignsCreate,
    steps: campaignsSteps,
    inboxes: campaignsInboxes,
    leads: campaignsLeads,
    start: (a) => campaignsSetStatus(a, "active", "start"),
    pause: (a) => campaignsSetStatus(a, "paused", "pause"),
    status: campaignsStatus,
  };
  const fn = table[sub];
  if (!fn) die(`unknown campaigns subcommand: ${sub}\nRun \`argorant campaigns help\` for usage.`);
  await fn(rest);
}

function help() {
  const p = bold("argorant");
  console.log(`
${bold("Argorant")} — verified B2B contacts from your terminal  ${dim("v" + VERSION)}

${bold("USAGE")}
  ${p} <command> "<query>" [filters]

${bold("COMMANDS")}
  ${cyan("login")} [key]                Save an API key (or set ARGORANT_API_KEY)
  ${cyan("logout")}                     Forget the saved key and base (~/.argorant/config.json)
  ${cyan("whoami")}                     Account, scopes, and daily quota
  ${cyan("count")} "<query>"            Count matching contacts        ${dim("(0 contact credits)")}
  ${cyan("company")} <company.com>       Count people at one company + masked role preview ${dim("(0 contact credits)")}
  ${cyan("search")} "<query>" -n 10     Preview matches, details redacted ${dim("(0 contact credits)")}
  ${cyan("sample")} <company.com>        Build 25 distinct, live-valid company leads ${dim("(free sample)")}
  ${cyan("reveal")} "<query>" -n 25     Reveal full contact details    ${dim("(uses credits; live-verified, pay only for deliverable)")}
  ${cyan("export")} "<query>" -n 1000 -o leads.csv   Verified CSV export ${dim("(uses credits)")}
  ${cyan("export status")} <job_id>     Status of an existing export  ${dim("(free; add --batch for >50k)")}
  ${cyan("export download")} <job_id> -o leads.csv   Re-download a finished export ${dim("(free)")}
  ${cyan("list create")} --name "<n>" [filters]      Save a reusable list ${dim("(free)")}
  ${cyan("list status")} <id>           Show a saved list's size       ${dim("(free)")}
  ${cyan("verify")} <email>             Verify one of your own emails  ${dim("(verification pool)")}
  ${cyan("verify")} --file emails.csv -o out.csv      Bulk-verify your own list ${dim("(recent re-checks free)")}
  ${cyan("campaigns")} ...                Live outbound campaigns from the terminal ${dim("(operator keys only — argorant campaigns help)")}

${bold("FILTERS")}
  --keywords <k>     Comma = OR. The widest, most reliable filter - prefer it
                     over --industry (matches tags most records carry).
  --title <t>        --exclude-title <t>  --seniority <s>    --department <d>
  --industry <i>     --country <c>        --geography <r>    --state <s>
  --city <c>         --company <name>     --domain <domain>
  --has-phone        --has-linkedin       --has-email          --verified-only
  ${dim("--title is abbreviation-aware (CFO ↔ Chief Financial Officer).")}
  ${dim("--verified-only keeps deliverable contacts; export verifies live & bills only valid.")}
  ${dim("--country / --geography accept regions: Europe, EMEA, DACH, Nordics, APAC, LATAM, GCC…")}
  ${dim("--exclude-title works fully with `export` and `list create`; `count`/`search`/`reveal` don't apply it yet (CLI warns).")}

${bold("OPTIONS")}
  -n, --limit <n>    Max rows           -o, --output <file>   CSV path (export)
      --json         Raw JSON output    -y, --yes             Skip confirmations
      --base <url>   Override API base  (or ARGORANT_API_BASE)
      --batch        Treat the id in \`export status/download\` as a batch id
      --grade <g>    valid (default) or valid-plus-catchall - which deliverable
                     grade to include on reveal/export. You only ever pay for
                     deliverable contacts; this is the one grade distinction
                     exposed anywhere. ${dim("(coming soon - currently a no-op; see docs)")}

${bold("NON-INTERACTIVE USE")} ${dim("(agents, CI, pipes)")}
  ${red("reveal, export, and verify --file SPEND CREDITS WITHOUT A PROMPT")} whenever
  stdin is not a TTY, or when --yes / --json is passed. The confirmation is a
  convenience for humans at a terminal, never a safety net. Check your -n.

${bold("EXIT CODES")}
  0 ok   ·   1 error   ·   2 not authenticated   ·   3 forbidden (missing scope)
  4 rate limit / daily quota   ·   5 plan upgrade required

${bold("EXAMPLES")}
  ${p} count "fintech CFOs in germany"
  ${p} company stripe.com
  ${p} search "heads of procurement" --country Germany -n 10
  ${p} sample recruitcrm.io -o sample.csv
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
  // `campaigns` has its own flag vocabulary (--step, --count, --pool, --csv, ...)
  // handled by readFlags — it never goes through the generic filter parser
  // below, which would reject those flags as unknown.
  if (cmd === "campaigns") {
    try {
      await cmdCampaigns(argv.slice(1));
    } catch (e) {
      die(e && e.message ? e.message : String(e));
    }
    return;
  }
  const args = applySavedBase(parseArgs(argv.slice(1)));
  const table = {
    login: cmdLogin,
    logout: cmdLogout,
    whoami: cmdWhoami,
    count: cmdCount,
    company: cmdCompany,
    search: cmdSearch,
    sample: cmdSample,
    reveal: cmdReveal,
    export: cmdExport,
    list: cmdList,
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
