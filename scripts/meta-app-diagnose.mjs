// Why can't a non-role user connect their Pages?
//
//   node scripts/meta-app-diagnose.mjs
//   node scripts/meta-app-diagnose.mjs --token <a user access token>
//
// Read-only: every call is a GET, nothing is created, changed or published.
//
// The question this answers is the one the dashboard makes hard to see: an app
// being **Live** and an app's **permissions having Advanced Access** are two
// different switches, and only the second one lets a user with no role on the
// app grant page/IG permissions. Live mode alone changes nothing for those
// users — per Meta's own access-levels doc, "Permissions with Standard Access
// can only be requested from app users who have a role on the requesting app."
//
// With --token (grab one from the browser after a connect attempt, or from
// Graph Explorer) it also reports which of our ten scopes that token actually
// carries, which is the fastest way to find the single permission that is
// holding the connect back.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

// Minimal .env parse (CRLF-safe) — same approach as the other scripts here.
try {
  for (let line of readFileSync(join(here, "..", ".env"), "utf8").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0 && !process.env[line.slice(0, i).trim()]) {
      process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
} catch {
  console.log("!  No backend/.env found — relying on the ambient environment.\n");
}

const args = process.argv.slice(2);
const userToken = (() => {
  const i = args.indexOf("--token");
  return i >= 0 ? args[i + 1] : null;
})();

const GRAPH = "https://graph.facebook.com/v23.0";

// The exact ten this app requests. Kept in step with FACEBOOK_SCOPES in
// modules/auth/auth.controller.ts and the frontend's FB.login scope.
const REQUESTED_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_engagement",
  "read_insights",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_insights",
];

const appId = (process.env.FACEBOOK_CLIENT_ID || "").trim();
const appSecret = (process.env.FACEBOOK_CLIENT_SECRET || "").trim();

if (!appId || !appSecret) {
  console.error("x  FACEBOOK_CLIENT_ID / FACEBOOK_CLIENT_SECRET are not set — nothing to check.");
  process.exit(1);
}

// The app access token. Safe to build this way (it IS the documented form) but
// never log it: it is equivalent to the secret.
const appToken = `${appId}|${appSecret}`;

async function get(path, token, fields) {
  const params = new URLSearchParams({ access_token: token });
  if (fields) params.set("fields", fields);
  const res = await fetch(`${GRAPH}/${path}?${params}`);
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

const line = (s = "") => console.log(s);
const head = (s) => {
  line();
  line(s);
  line("-".repeat(s.length));
};

line(`Meta app diagnosis — app ${appId}`);

// ── 1. Does the secret work at all? ──────────────────────────────────────
head("1. App credentials");
const app = await get(appId, appToken, "id,name,app_type,link,privacy_policy_url,restrictions");
if (!app.ok) {
  line(`x  Could not read the app: ${app.data?.error?.message || app.status}`);
  line("   If this says the secret is wrong, FACEBOOK_CLIENT_SECRET is stale — regenerate it in");
  line("   App Settings -> Basic and update backend/.env. Nothing below will be meaningful.");
  process.exit(1);
}
line(`ok App reachable: "${app.data.name}" (type ${app.data.app_type ?? "?"})`);
line(`   FACEBOOK_CLIENT_ID and FACEBOOK_CLIENT_SECRET are a valid pair.`);

// ── 2. Is Meta restricting the app? ──────────────────────────────────────
head("2. Restrictions");
const restrictions = app.data.restrictions;
if (restrictions && Object.keys(restrictions).length) {
  line("x  Meta reports RESTRICTIONS on this app:");
  line(`   ${JSON.stringify(restrictions)}`);
  line();
  line("   This is a different problem from access levels, and it outranks them — a restricted");
  line("   app refuses non-role users no matter what the permissions say. Check the Alerts tab");
  line("   in the App Dashboard for the notice and the appeal link. The two usual causes are an");
  line("   overdue annual **Data Use Checkup** and a failed **Business Verification**.");
} else {
  line("ok Meta reports no restrictions object on the app.");
  line("   (Not conclusive — a policy restriction can still show only as a dashboard Alert.");
  line("    Check App Dashboard -> Alerts too.)");
}

// ── 3. Live vs Development ───────────────────────────────────────────────
head("3. App mode");
// There is no supported field for app mode on the app node, so infer it: in
// Development mode Meta will not serve the app's public "About" page.
line(`   Dashboard toggle: App Dashboard -> top bar -> "App mode: Live / Development".`);
line(`   Public app page: ${app.data.link || `https://www.facebook.com/games/?app_id=${appId}`}`);
line();
line("   Live mode is NECESSARY for non-role users but NOT SUFFICIENT. Read section 4.");

// ── 4. The actual answer ─────────────────────────────────────────────────
head("4. Access levels — the usual cause");
line("Meta does not expose per-permission access levels over the API, so this must be read");
line("in the dashboard. Go to:");
line();
line("   App Dashboard -> App Review -> Permissions and Features");
line();
line("and check the **Access Level** column for each of the ten permissions this app requests.");
line("Anything reading \"Standard Access\" works ONLY for users holding a role on the app");
line("(Admin / Developer / Tester). That is precisely the symptom you are seeing.");
line();
for (const s of REQUESTED_SCOPES) line(`   [ ] ${s}`);
line();
line("Every one of those needs **Advanced Access** for a non-role user to connect their Page.");
line("Getting there requires, in order:");
line("   1. Business Verification on the owning Business Portfolio  (blocks everything else)");
line("   2. Tech Provider status — required because this app manages Pages owned by OTHER");
line("      businesses, which is exactly what a client's Page is");
line("   3. App Review per permission: a screencast + written justification each");

// ── 5. Token scopes, when one was supplied ───────────────────────────────
if (userToken) {
  head("5. What a real token actually carries");
  const dbg = await fetch(
    `${GRAPH}/debug_token?input_token=${encodeURIComponent(userToken)}&access_token=${appToken}`,
  );
  const dbgData = await dbg.json().catch(() => null);
  const d = dbgData?.data;

  if (!dbg.ok || !d) {
    line(`x  Could not inspect that token: ${dbgData?.error?.message || dbg.status}`);
  } else {
    line(`   Token app id : ${d.app_id}${String(d.app_id) === appId ? " (ok — matches this app)" : " x  MISMATCH: this token belongs to a DIFFERENT app"}`);
    line(`   Type         : ${d.type || "?"}`);
    line(`   Valid        : ${d.is_valid ? "yes" : "no"}`);
    line(`   Expires      : ${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : "never / unknown"}`);
    if (d.error) line(`   x  Token error: ${d.error.message}`);

    const granted = d.scopes || [];
    const missing = REQUESTED_SCOPES.filter((s) => !granted.includes(s));
    line();
    line(`   Granted scopes (${granted.length}): ${granted.join(", ") || "none"}`);
    if (missing.length) {
      line();
      line(`   x  WITHHELD (${missing.length}):`);
      for (const m of missing) line(`      - ${m}`);
      line();
      line("      A permission missing here despite being requested is the signature of");
      line("      Standard Access + a non-role user: Meta drops it silently rather than");
      line("      erroring. These are the ones to get Advanced Access on first.");
    } else {
      line();
      line("   ok All ten requested scopes are present on this token.");
      line("      So access levels are NOT the problem for this user — look instead at whether");
      line("      they hold a Page role that includes CREATE_CONTENT, and at /me/accounts being");
      line("      empty (a user who is only an Ad account admin sees no Pages).");
    }
  }
} else {
  head("5. Token inspection (skipped)");
  line("   Re-run with --token <user access token> to see which scopes a real login actually");
  line("   carries. That pinpoints the blocking permission in one call.");
  line("   Get one from Graph Explorer, or from the app: sign in, then read the token the");
  line("   connect flow received in the browser console.");
}

head("Fastest way to see Meta's real refusal text");
line("The JS-SDK popup shows Meta's reason inside a window that closes before our code runs,");
line("so the app can only guess. The redirect flow does not have that problem — Meta puts the");
line("reason in the query string, and the callback now forwards it verbatim. Have the affected");
line("user open this directly:");
line();
line(`   ${(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "")}  ->  then visit:`);
line(`   ${process.env.FACEBOOK_REDIRECT_URI?.replace("/callback", "/start") || "http://localhost:4000/api/auth/facebook/start"}`);
line();
line("The resulting ?error= toast (and the backend log line) carries Meta's own wording,");
line("error_reason and error_code — which is what distinguishes an access-level refusal from");
line("a restricted app, a bad redirect URI, or a genuine user cancellation.");
line();
