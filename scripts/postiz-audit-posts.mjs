// Audit what actually happened to Postiz-backed posts (Threads / standalone
// Instagram / X). READ-ONLY: every call is a GET or a SELECT, nothing is
// created, published, retried or modified.
//
//   node scripts/postiz-audit-posts.mjs                        # last 7 days, all postiz channels
//   node scripts/postiz-audit-posts.mjs --days 14
//   node scripts/postiz-audit-posts.mjs --channel "ES MLB"     # substring, case-insensitive
//   node scripts/postiz-audit-posts.mjs --platform threads
//   node scripts/postiz-audit-posts.mjs --json                 # machine-readable
//
// WHY THIS EXISTS
//
// A Postiz publish is two steps, and the app only ever sees the first:
//
//   1. we POST /posts type:"now"  → Postiz accepts and returns a post id, and
//      we immediately mark the target "sent";
//   2. Postiz then publishes to the platform, asynchronously, and can fail
//      there — rate limit, duplicate content, a re-auth'd channel — long after
//      step 1 said 200.
//
// So "sent" in our DB means "Postiz accepted it", NOT "it appeared on Threads".
// The verify-posts cron reconciles the difference by looking the post up in
// Postiz, but only for 24h after sent_at, only every 3h, and only if the
// lookup finds the row at all. This script asks Postiz directly, with no time
// limit and no reliance on that reconcile having worked.
//
// It deliberately does NOT reuse lib/postiz.js getPostizPostState(): part of
// what is under suspicion IS that lookup (a windowed list that may paginate),
// and auditing it with itself would hide exactly the failure being looked for.
// The raw listing size is reported so a truncated page is visible rather than
// silently producing "not found".
import pg from "pg";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const DAYS = Number(valueOf("--days", "7")) || 7;
const CHANNEL = valueOf("--channel");
const PLATFORM = valueOf("--platform");
const AS_JSON = has("--json");

// Minimal .env parse (CRLF-safe) — same approach as reset-password.mjs.
const here = dirname(fileURLToPath(import.meta.url));
for (let line of readFileSync(join(here, "..", ".env"), "utf8").split(/\r?\n/)) {
  line = line.trim();
  if (!line || line.startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i > 0 && !process.env[line.slice(0, i).trim()]) {
    process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

const API = (process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1").replace(/\/$/, "");
const KEY = (process.env.POSTIZ_API_KEY || "").trim();
if (!KEY) {
  console.error("POSTIZ_API_KEY is not set in backend/.env — nothing to audit against.");
  process.exit(1);
}

// Postiz wants the key RAW in Authorization, not as a Bearer token.
async function get(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: KEY } });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

const pool = new pg.Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD || "password",
  database: process.env.DB_NAME || "posting_pilot_db",
});

// ── 1. Channel health in Postiz ────────────────────────────────────────────
// A channel disabled or re-authorized in Postiz fails EVERY post to it while
// our side still shows a healthy account, so check this before the per-post
// detail — it explains a whole channel at once.
let integrations = [];
try {
  const raw = await get("/integrations");
  integrations = (Array.isArray(raw) ? raw : raw?.integrations || []).map((r) => ({
    id: r.id,
    name: r.name || r.profile || "(unnamed)",
    provider: r.identifier,
    disabled: !!r.disabled,
  }));
} catch (e) {
  console.error(`Could not list Postiz channels: ${e.message}`);
}

const { rows: accounts } = await pool.query(
  `select id, display_name, platform, external_account_id, posting_locked,
          metadata->'postiz'->>'provider' as provider
     from social_accounts
    where publish_via = 'postiz'
      ${PLATFORM ? "and platform = $1" : ""}
    order by platform, lower(display_name)`,
  PLATFORM ? [PLATFORM] : [],
);

const wanted = accounts.filter(
  (a) => !CHANNEL || a.display_name.toLowerCase().includes(CHANNEL.toLowerCase()),
);
if (!wanted.length) {
  console.error(`No Postiz-backed accounts matched${CHANNEL ? ` "${CHANNEL}"` : ""}.`);
  await pool.end();
  process.exit(1);
}

const byIntegration = new Map(integrations.map((i) => [String(i.id), i]));

// ── 2. Our record of every target in the window ────────────────────────────
const { rows: targets } = await pool.query(
  `select pt.id, pt.status, pt.external_post_id, pt.sent_at, pt.last_error,
          pt.permalink, pt.last_verified_at,
          sp.id as post_id, sp.body, sp.scheduled_for, sp.status as post_status,
          sa.id as account_id, sa.display_name, sa.platform
     from post_targets pt
     join scheduled_posts sp on sp.id = pt.post_id
     join social_accounts sa on sa.id = pt.social_account_id
    where sa.id = any($1::uuid[])
      and sp.scheduled_for >= now() - ($2 || ' days')::interval
    order by sa.display_name, sp.scheduled_for`,
  [wanted.map((a) => a.id), String(DAYS)],
);

// ── 3. What Postiz says, one listing per channel window ────────────────────
// Postiz exposes no get-post-by-id, only a date-windowed list. Fetch ONE wide
// window covering the whole audit and index it, rather than a ±2-day call per
// post: fewer calls, and the size of the result is itself the signal for
// whether the listing is being truncated.
const from = new Date(Date.now() - (DAYS + 2) * 86400000).toISOString();
const to = new Date(Date.now() + 2 * 86400000).toISOString();

let postizPosts = [];
let listError = null;
try {
  const raw = await get(`/posts?${new URLSearchParams({ startDate: from, endDate: to })}`);
  postizPosts = Array.isArray(raw) ? raw : raw?.posts || [];
} catch (e) {
  listError = e.message;
}
const byPostId = new Map(postizPosts.map((p) => [String(p?.id), p]));

const verdictOf = (t) => {
  if (!t.external_post_id) {
    return t.status === "failed"
      ? { code: "FAILED_BEFORE_POSTIZ", note: t.last_error || "no error recorded" }
      : { code: "NEVER_SENT", note: `target is "${t.status}" with no Postiz id` };
  }
  if (String(t.external_post_id).includes("_mock_")) return { code: "MOCK", note: "mock mode" };
  const p = byPostId.get(String(t.external_post_id));
  if (!p) return { code: "NOT_IN_POSTIZ", note: "Postiz has no post with this id in the window" };
  const state = p.state || "(no state)";
  if (state === "ERROR") return { code: "POSTIZ_ERROR", note: "Postiz reports the platform rejected it" };
  if (p.releaseURL) return { code: "DELIVERED", note: p.releaseURL };
  return { code: "ACCEPTED_NO_URL", note: `state=${state}, no releaseURL yet` };
};

const report = [];
for (const t of targets) {
  const v = verdictOf(t);
  report.push({
    channel: t.display_name,
    platform: t.platform,
    postId: t.post_id,
    scheduledFor: t.scheduled_for,
    caption: (t.body || "").replace(/\s+/g, " ").slice(0, 60),
    ourStatus: t.status,
    ourError: t.last_error,
    postizId: t.external_post_id,
    sentAt: t.sent_at,
    lastVerifiedAt: t.last_verified_at,
    verdict: v.code,
    detail: v.note,
  });
}

if (AS_JSON) {
  console.log(JSON.stringify({ days: DAYS, listError, postizWindowSize: postizPosts.length, report }, null, 2));
  await pool.end();
  process.exit(0);
}

// ── Output ─────────────────────────────────────────────────────────────────
console.log(`\nPostiz post audit — last ${DAYS} day(s), ${wanted.length} channel(s)\n${"=".repeat(64)}`);

console.log("\nCHANNEL HEALTH (Postiz side)");
for (const a of wanted) {
  const integ = byIntegration.get(String(a.external_account_id));
  const flags = [];
  if (!integ) flags.push("!! NOT FOUND in Postiz — integration id is stale, re-import this channel");
  else if (integ.disabled) flags.push("!! DISABLED in Postiz — every post to it will fail");
  if (a.posting_locked) flags.push("locked in Pilot (posting off)");
  console.log(`  ${a.display_name} [${a.platform}/${a.provider || "?"}] ${flags.length ? flags.join("; ") : "ok"}`);
}

if (listError) {
  console.log(`\n!! Could not list posts from Postiz: ${listError}`);
  console.log("   Every verdict below that says NOT_IN_POSTIZ is therefore unreliable.");
} else {
  console.log(`\nPostiz returned ${postizPosts.length} post(s) for the window.`);
  // A round number is the classic shape of a silently truncated page, and a
  // truncated page turns "delivered" into a false "NOT_IN_POSTIZ".
  if ([10, 20, 25, 50, 100, 200].includes(postizPosts.length)) {
    console.log("   !! That is exactly a common page size — the listing may be TRUNCATED,");
    console.log("      which would make NOT_IN_POSTIZ verdicts false. Narrow --days and re-run.");
  }
}

let current = null;
for (const r of report) {
  if (r.channel !== current) {
    current = r.channel;
    console.log(`\n${current} (${r.platform})\n${"-".repeat(Math.min(64, current.length + 12))}`);
  }
  const when = new Date(r.scheduledFor).toISOString().replace("T", " ").slice(0, 16);
  const mark = { DELIVERED: "OK  ", POSTIZ_ERROR: "FAIL", NOT_IN_POSTIZ: "??  ", NEVER_SENT: "----", FAILED_BEFORE_POSTIZ: "FAIL", ACCEPTED_NO_URL: "... ", MOCK: "mock" }[r.verdict] || "?   ";
  console.log(`  ${mark} ${when}  "${r.caption}"`);
  console.log(`       ours: ${r.ourStatus}${r.ourError ? ` — ${r.ourError}` : ""}`);
  console.log(`       postiz: ${r.verdict} — ${r.detail}`);
}

const counts = report.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
console.log(`\n${"=".repeat(64)}\nSUMMARY (${report.length} target(s))`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log(`
How to read this:
  DELIVERED             Postiz published it and gave a permalink. Live.
  POSTIZ_ERROR          Postiz accepted it, then the platform rejected it.
                        Our app may still show this target as "sent".
  NOT_IN_POSTIZ         We hold a post id Postiz doesn't return for this window.
                        Either the listing is truncated (see the warning above)
                        or the post was deleted in Postiz. NOT proof it failed.
  ACCEPTED_NO_URL       In Postiz, not published yet or no permalink recorded.
  FAILED_BEFORE_POSTIZ  Our call to Postiz failed. 'ours' carries the reason —
                        a 429 here means the workspace create-post limit.
  NEVER_SENT            The cron never reached this target at all.
`);

await pool.end();
