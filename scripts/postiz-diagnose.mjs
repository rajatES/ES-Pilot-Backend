// Check the Postiz integration end to end WITHOUT PUBLISHING ANYTHING.
//
//   node scripts/postiz-diagnose.mjs                # ping + list channels only
//   node scripts/postiz-diagnose.mjs --dry-run      # + full pipeline via drafts
//   node scripts/postiz-diagnose.mjs --dry-run --channel <integrationId>
//   node scripts/postiz-diagnose.mjs --dry-run --all # every channel, not one per provider
//   node scripts/postiz-diagnose.mjs --dry-run --keep # leave the drafts in Postiz
//
// Safe by design. Without --dry-run it makes only GET calls. With --dry-run it
// creates each test post as type:"draft" — Postiz stores a draft against the
// integration but never schedules or publishes it — and deletes it immediately
// after. Nothing reaches Threads or Instagram at any point.
//
// It calls the SAME functions the app publishes with (from dist/, so run
// `npm run build` first), which is the point: a hand-written payload here could
// pass while production failed.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

// Minimal .env parse (CRLF-safe) — same approach as reset-password.mjs.
const envPath = join(here, "..", ".env");
for (let line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  line = line.trim();
  if (!line || line.startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i > 0 && !process.env[line.slice(0, i).trim()]) {
    process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

// The compiled lib is CommonJS (nest tsc output); createRequire is the reliable
// way to load it from an ESM script.
const require = createRequire(import.meta.url);
let postiz;
try {
  postiz = require(join(here, "..", "dist", "lib", "postiz.js"));
} catch (e) {
  console.error("Could not load dist/lib/postiz.js — run `npm run build` in backend/ first.");
  console.error(e.message);
  process.exit(1);
}

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

console.log("\nPostiz integration check — no post is ever published by this script.\n");

// ── 1. Config + auth ──────────────────────────────────────────────────────
if (!postiz.postizConfigured()) {
  console.log(bad("✗ POSTIZ_API_KEY is not set in backend/.env"));
  process.exit(1);
}
console.log(`${ok("✓")} POSTIZ_API_KEY present ${dim(`(${(process.env.POSTIZ_API_KEY || "").trim().length} chars)`)}`);
console.log(`  ${dim(`base URL: ${process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1"}`)}`);
const mode = (process.env.FACEBOOK_PUBLISH_MODE || "").trim().toLowerCase();
console.log(`  ${dim(`FACEBOOK_PUBLISH_MODE=${process.env.FACEBOOK_PUBLISH_MODE || "(unset)"} → live calls ${mode === "live" ? "ON" : "OFF (everything is mocked)"}`)}`);

try {
  const { connected } = await postiz.postizPing();
  console.log(`${connected ? ok("✓") : bad("✗")} GET /is-connected → connected=${connected}`);
  if (!connected) process.exit(1);
} catch (e) {
  console.log(`${bad("✗")} GET /is-connected → ${e.message}`);
  process.exit(1);
}

// ── 2. Channels ───────────────────────────────────────────────────────────
let channels = [];
try {
  channels = await postiz.listPostizIntegrations();
  console.log(`${ok("✓")} GET /integrations → ${channels.length} supported channel(s)`);
} catch (e) {
  console.log(`${bad("✗")} GET /integrations → ${e.message}`);
  process.exit(1);
}

if (!channels.length) {
  console.log(
    `\n${dim("No Threads or Instagram channels in this Postiz workspace yet — connect one in Postiz, then re-run.")}`,
  );
  console.log(dim(`Supported providers: ${Object.keys(postiz.POSTIZ_PROVIDERS).join(", ")}`));
  process.exit(0);
}

for (const c of channels) {
  console.log(
    `    ${c.provider.padEnd(21)} ${String(c.name).padEnd(28)} ${dim(`platform=${c.platform} id=${c.id}${c.profile ? ` @${c.profile}` : ""}${c.disabled ? " DISABLED" : ""}`)}`,
  );
}

// ── 3. Full pipeline via drafts (opt-in) ──────────────────────────────────
if (!has("--dry-run")) {
  console.log(`\n${dim("Read-only check done. Add --dry-run to exercise upload + create + delete via drafts.")}`);
  process.exit(0);
}

const only = valueOf("--channel");
let targets = channels.filter((c) => !c.disabled);
if (only) targets = targets.filter((c) => c.id === only);
else if (!has("--all")) {
  // One channel per provider is enough to validate each settings payload shape.
  const seen = new Set();
  targets = targets.filter((c) => (seen.has(c.provider) ? false : seen.add(c.provider)));
}

if (!targets.length) {
  console.log(bad(`\nNo matching enabled channel${only ? ` for id ${only}` : ""}.`));
  process.exit(1);
}

console.log(`\nDry run over ${targets.length} channel(s) — draft created then deleted, never published:`);

let allOk = true;
for (const c of targets) {
  console.log(`\n  ${c.name} ${dim(`(${c.provider})`)}`);
  const result = await postiz.dryRunPostizChannel({
    // Shaped like a social_accounts row so the lib takes its normal path.
    account: {
      display_name: c.name,
      platform: c.platform,
      external_account_id: c.id,
      metadata: { postiz: { provider: c.provider } },
    },
    // The channel's own avatar is a public https URL on uploads.postiz.com —
    // proves upload-from-url works without depending on a third-party host.
    mediaUrl: valueOf("--media") || c.picture || null,
    keepDraft: has("--keep"),
  });
  for (const s of result.steps) {
    console.log(`    ${s.ok ? ok("✓") : bad("✗")} ${s.name.padEnd(17)} ${dim(s.detail)}`);
  }
  if (!result.ok) allOk = false;
}

console.log(
  allOk
    ? `\n${ok("All channels passed the full pipeline (media ingest → create → delete). Nothing was published.")}\n`
    : `\n${bad("Some steps failed — see above.")}\n`,
);
process.exit(allOk ? 0 : 1);
