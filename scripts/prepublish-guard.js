#!/usr/bin/env node
"use strict";

// Publish guard — runs as `prepublishOnly`, so `npm publish` aborts before
// anything reaches the registry.
//
// It exists because 0.4.0 went out as a v0.3.0 build with only the version
// field bumped: the tree that was packed was not the tree that was committed,
// and nobody noticed until customers hit `unknown command: company`. Two
// checks close that failure class for good:
//
//   1. the git working tree must be clean, so what is packed is exactly what
//      is committed and `gitHead` in the registry metadata means something;
//   2. the version in package.json must not already exist on npm, so a
//      re-publish of an existing version can never be attempted.

const { execFileSync } = require("child_process");
const path = require("path");

const pkg = require(path.join(__dirname, "..", "package.json"));
const fail = (msg) => {
  process.stderr.write(`\n\x1b[31mpublish blocked:\x1b[0m ${msg}\n\n`);
  process.exit(1);
};
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: path.join(__dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// --- 1. clean tree -----------------------------------------------------------
let status;
try {
  status = run("git", ["status", "--porcelain"]);
} catch (e) {
  fail(`cannot run git to verify the working tree is clean (${e.message}).`);
}
if (status) {
  fail(
    "the git working tree is dirty — commit or stash first so the published tarball matches a real commit:\n" +
      status.split("\n").map((l) => `  ${l}`).join("\n")
  );
}

let head = "unknown";
try {
  head = run("git", ["rev-parse", "--short", "HEAD"]);
} catch {
  /* non-fatal: the clean check above already passed */
}

// --- 2. version not already published ---------------------------------------
let published = [];
try {
  published = JSON.parse(run("npm", ["view", `${pkg.name}`, "versions", "--json"]) || "[]");
  if (!Array.isArray(published)) published = [published];
} catch (e) {
  // A brand-new package (E404) is fine; anything else means we could not
  // verify — refuse rather than risk clobbering.
  const out = `${(e.stdout || "") + (e.stderr || "")}`;
  if (!/E404|is not in this registry|404 Not Found/i.test(out)) {
    fail(`cannot reach npm to verify ${pkg.name}@${pkg.version} is unpublished (${out.trim().split("\n").pop() || e.message}).`);
  }
}
if (published.includes(pkg.version)) {
  fail(
    `${pkg.name}@${pkg.version} already exists on npm. Bump the version — a published version is never re-published or re-tagged.\n` +
      `  published: ${published.join(", ")}`
  );
}

process.stdout.write(`publish guard ok — ${pkg.name}@${pkg.version} from clean tree ${head}\n`);
