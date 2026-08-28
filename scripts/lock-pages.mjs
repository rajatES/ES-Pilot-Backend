// Lock or unlock connected pages, straight in Postgres.
//
//   node scripts/lock-pages.mjs lock   --platform=instagram "Essentially W" "Essentially CFB"
//   node scripts/lock-pages.mjs unlock --platform=instagram "Essentially W"
//   node scripts/lock-pages.mjs list
//
// This is the same switch as the padlock in Accounts → Manage (social_accounts.
// posting_locked); the script exists so a batch of pages can be done in one go,
// and so the change is reproducible on another environment.
//
// Locking does NOT disconnect anything: the row, its token, its followers, its
// insights and its post history are untouched, and the token-refresh cron keeps
// the account alive. Only publishing is refused — by assertPublishable() in
// lib/postContent.js, which every publish path (composer, publish-now, cron,
// approvals, Developer API) runs through.
//
// Names are matched case-insensitively against display_name. --platform
// narrows the match, which matters here: an Instagram profile and a Facebook
// Page frequently share a name, and locking the wrong one is silent.
import pg from "pg";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const argv = process.argv.slice(2);
const mode = (argv[0] || "").toLowerCase();
const platform = (argv.find((a) => a.startsWith("--platform=")) || "").split("=")[1] || null;
const names = argv.slice(1).filter((a) => !a.startsWith("--"));

if (!["lock", "unlock", "list"].includes(mode)) {
  console.error(
    "Usage:\n" +
      '  node scripts/lock-pages.mjs lock   --platform=instagram "Page A" "Page B"\n' +
      '  node scripts/lock-pages.mjs unlock --platform=instagram "Page A"\n' +
      "  node scripts/lock-pages.mjs list",
  );
  process.exit(1);
}
if (mode !== "list" && !names.length) {
  console.error(`Give at least one page name to ${mode}.`);
  process.exit(1);
}

// Config comes from the environment first, then from backend/.env for the
// values it didn't already carry. The .env is OPTIONAL on purpose: on the
// server this runs inside the backend container, where compose supplies every
// value through env_file and .dockerignore keeps .env out of the image — so
// insisting on the file would make the script unrunnable exactly where it is
// needed. Locally the file is present and fills everything in.
//
// process.env wins because compose's `environment:` block overrides env_file
// (DB_HOST=postgres-db inside the network vs localhost in the file), and the
// running container's view is the correct one.
const env = {};
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  for (let line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
} catch {
  // No .env — running in the container, where the environment already has it.
}
const cfg = (k, d) => process.env[k] || env[k] || d;

const pool = new pg.Pool({
  host: cfg("DB_HOST", "localhost"),
  port: Number(cfg("DB_PORT", "5432")) || 5432,
  user: cfg("DB_USERNAME", "postgres"),
  password: cfg("DB_PASSWORD", "password"),
  database: cfg("DB_NAME", "posting_pilot_db"),
});

const label = (r) => `${r.display_name} (${r.platform})`;

if (mode === "list") {
  const { rows } = await pool.query(
    `select display_name, platform, posting_locked
       from social_accounts
      ${platform ? "where platform = $1" : ""}
      order by posting_locked desc, platform, lower(display_name)`,
    platform ? [platform] : [],
  );
  const locked = rows.filter((r) => r.posting_locked);
  console.log(`${rows.length} account(s); ${locked.length} locked:`);
  for (const r of locked) console.log(`  🔒 ${label(r)}`);
  if (!locked.length) console.log("  (none)");
  await pool.end();
  process.exit(0);
}

const locking = mode === "lock";
const lowered = names.map((n) => n.trim().toLowerCase());

const { rows: matched } = await pool.query(
  `select id, display_name, platform, posting_locked
     from social_accounts
    where lower(display_name) = any($1::text[])
      ${platform ? "and platform = $2" : ""}`,
  platform ? [lowered, platform] : [lowered],
);

const missing = names.filter((n) => !matched.some((r) => r.display_name.toLowerCase() === n.trim().toLowerCase()));
if (missing.length) {
  console.warn(`No ${platform || "account"} matched: ${missing.map((m) => `"${m}"`).join(", ")}`);
}
if (!matched.length) {
  console.error("Nothing to update — run `node scripts/lock-pages.mjs list` to see the exact names.");
  await pool.end();
  process.exit(1);
}

const { rows: updated } = await pool.query(
  `update social_accounts set posting_locked = $1 where id = any($2::uuid[])
   returning display_name, platform, posting_locked`,
  [locking, matched.map((r) => r.id)],
);

console.log(`${locking ? "LOCKED" : "UNLOCKED"} ${updated.length} page(s):`);
for (const r of updated) console.log(`  ${locking ? "🔒" : "🔓"} ${label(r)}`);

// Posts already queued to a now-locked page will fail at send time with
// "… is locked" rather than going out. Say so, because the fix (retarget or
// delete them) is the operator's call, not the script's.
if (locking) {
  const { rows: queued } = await pool.query(
    `select sa.display_name, count(*)::int as n
       from post_targets pt
       join social_accounts sa on sa.id = pt.social_account_id
       join scheduled_posts sp on sp.id = pt.post_id
      where pt.social_account_id = any($1::uuid[])
        and pt.status = 'scheduled'
        and sp.status in ('scheduled', 'pending_review')
      group by sa.display_name`,
    [matched.map((r) => r.id)],
  );
  if (queued.length) {
    console.log("\nStill queued to these pages (they will now fail instead of publishing):");
    for (const q of queued) console.log(`  ${q.display_name}: ${q.n} scheduled post(s)`);
    console.log("Retarget or delete them in Posts if you don't want the failures.");
  }
}

await pool.end();
