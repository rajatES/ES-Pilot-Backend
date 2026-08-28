// Instagram API with **Instagram Login** — the OAuth half.
//
// This is the second, independent way we reach Instagram natively, and the only
// one that needs no Facebook Page:
//
//   - `lib/facebookOAuth.js` → Instagram API with **Facebook Login**. The user
//     signs in with Facebook, we walk /me/accounts, and each IG account is
//     found hanging off a Page via `instagram_business_account`. The IG account
//     MUST be linked to a Page, and it publishes with that Page's token.
//   - THIS FILE → the user signs in with **Instagram**, on instagram.com. No
//     Facebook account, no Page, no Business Portfolio is involved at any
//     point. The account still must be a professional (Creator or Business)
//     account — no API publishes to a plain personal profile, which is a Meta
//     platform rule and not something a different integration can route around.
//
// The two paths issue DIFFERENT app credentials (an Instagram App ID, not the
// Facebook App ID) and talk to a DIFFERENT host (graph.instagram.com, not
// graph.facebook.com), but the publishing mechanics past that point are
// identical — container → poll status_code → media_publish. That is why
// `lib/instagram.js` only needed a per-account base URL rather than a fork.
//
// Token lifetime is the real operational difference. Facebook Page tokens are
// effectively permanent; these are 60-day tokens that must be refreshed while
// still valid (and at least 24h old). Miss the window and the account is dead
// with no way back but a full reconnect — so `cron.refreshTokens()` exists
// purely to keep them alive. Nothing else in this app has that requirement.
//
// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login

// Where the user authorizes. Note this is instagram.com, NOT facebook.com —
// the whole point of this path.
const AUTH_HOST = "https://www.instagram.com";
// Where an authorization code becomes a short-lived token.
const TOKEN_HOST = "https://api.instagram.com";
// Where every subsequent call goes, token exchange/refresh included.
const GRAPH_HOST = "https://graph.instagram.com";
// Every graph.instagram.com path must carry the API version.
//
// Meta's curl examples for the token endpoints omit it, and following them gives
// `IGApiException` "Unsupported request - method type: get" on a REAL token
// (observed live 2026-08-27 on BOTH /access_token and /refresh_access_token,
// with both GET and POST). The versioned `/v23.0/me` call in the same file works
// fine against the same host and token, which is what isolates the version as
// the difference rather than the grant or the method.
//
// A deliberately invalid token hides this: it fails at decode with
// `OAuthException` "Failed to decode" on versioned and unversioned paths alike,
// so probing with a fake token cannot tell them apart. Don't "simplify" these
// back to the unversioned form because the docs show it that way.
const API_VERSION = "v23.0";

// The permission set this path actually uses:
//   instagram_business_basic            — read the profile; also what makes a
//                                         token refreshable at all.
//   instagram_business_content_publish  — create and publish media.
//   instagram_business_manage_comments  — the composer's "first comment".
// Deliberately NOT requesting instagram_business_manage_messages: we have no
// inbox feature, and over-requesting is a documented App Review rejection
// reason (same rule already noted for the Facebook scopes in HANDOFF §13).
export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
];

export function instagramLoginConfigured() {
  return !!(
    (process.env.INSTAGRAM_APP_ID || "").trim() && (process.env.INSTAGRAM_APP_SECRET || "").trim()
  );
}

function redirectUri() {
  return process.env.INSTAGRAM_REDIRECT_URI || "http://localhost:4000/api/auth/instagram/callback";
}

// Meta's errors arrive in two different shapes on these hosts — the OAuth host
// answers with flat {error_type, error_message, code}, the graph host with the
// familiar nested {error:{message}}. Read both so a failure never surfaces as a
// bare status code.
function oauthErrorMessage(data, fallback) {
  const detail =
    data?.error_message ||
    data?.error?.message ||
    data?.error_description ||
    (typeof data?.error === "string" ? data.error : "") ||
    "";
  return detail ? `${fallback} — ${detail}` : fallback;
}

// ── Step 1: send the user to Instagram ───────────────────────────────────

export function getInstagramAuthUrl(state) {
  if (!instagramLoginConfigured()) {
    throw new Error("Instagram Login is not configured — set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET.");
  }
  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    redirect_uri: redirectUri(),
    // Meta accepts comma-separated here; a URL-encoded space list also works.
    scope: INSTAGRAM_SCOPES.join(","),
    response_type: "code",
    state,
  });
  return `${AUTH_HOST}/oauth/authorize?${params}`;
}

// ── Step 2: code → short-lived token ─────────────────────────────────────

// Unlike the Facebook exchange (a GET with query params) this one is a POST
// with a form-encoded body, and it rejects a JSON body. The code is single-use
// and valid for one hour.
export async function exchangeInstagramCode(code) {
  // Trimmed for the same reason as the long-lived exchange: a stray newline in
  // the server's .env otherwise reaches Meta inside the credential.
  const body = new URLSearchParams({
    client_id: (process.env.INSTAGRAM_APP_ID || "").trim(),
    client_secret: (process.env.INSTAGRAM_APP_SECRET || "").trim(),
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
    code: String(code).trim(),
  });

  const res = await fetch(`${TOKEN_HOST}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!res.ok || !data?.access_token) {
    console.error(`[instagram login] code exchange failed (HTTP ${res.status}): ${String(raw).slice(0, 500)}`);
    throw new Error(oauthErrorMessage(data, "Instagram rejected the authorization code."));
  }

  // Log the SHAPE, never the token. Whether this response carries an
  // `expires_in` is exactly what decides if the token is already long-lived —
  // the docs call it short-lived, but ig_exchange_token rejects it as though it
  // isn't (see exchangeForLongLivedInstagramToken). This line is how we find out
  // without guessing.
  console.log(
    `[instagram login] code exchange ok — fields: [${Object.keys(data).join(", ")}]` +
      (data.expires_in !== undefined ? `, expires_in=${data.expires_in}s (~${Math.round(Number(data.expires_in) / 86400)}d)` : ", no expires_in"),
  );
  return {
    accessToken: data.access_token,
    // The Instagram-scoped user id. Kept as a fallback for the profile lookup,
    // which is the authoritative source for what we store.
    userId: data.user_id ? String(data.user_id) : null,
    permissions: data.permissions || null,
  };
}

// ── TEMPORARY: which long-lived exchange does Meta actually accept? ──────
//
// SCAFFOLDING (added 2026-08-27). Delete this function and its one call site
// once the working variant is known.
//
// Why it has to live here rather than in a script: the only token that reaches
// the failing code path is the short-lived one, which exists for about a second
// inside an interactive connect and is never persisted. Probing from outside
// with a synthetic token is useless — an undecodable token fails earlier, with
// `OAuthException` "Failed to decode", so EVERY variant looks healthy. Three
// hypotheses (missing API version, wrong grant, wrong HTTP method) were each
// "confirmed" by such a probe and each turned out wrong against a real token.
//
// So: on failure, try the candidates with the real token and report which one
// Meta accepts. Never logs a token value — only the variant label, the status,
// and Meta's error message.
async function probeLongLivedVariants(token) {
  const secret = (process.env.INSTAGRAM_APP_SECRET || "").trim();
  const appId = (process.env.INSTAGRAM_APP_ID || "").trim();

  const base = { grant_type: "ig_exchange_token", client_secret: secret, access_token: token };
  const candidates = [
    ["IG unversioned GET", "https://graph.instagram.com/access_token", "GET", base],
    ["IG v23.0 GET", "https://graph.instagram.com/v23.0/access_token", "GET", base],
    ["IG v22.0 GET", "https://graph.instagram.com/v22.0/access_token", "GET", base],
    ["IG v21.0 GET", "https://graph.instagram.com/v21.0/access_token", "GET", base],
    ["IG v23.0 POST", "https://graph.instagram.com/v23.0/access_token", "POST", base],
    // Maybe client_id is required alongside the secret, despite the docs.
    ["IG v23.0 GET +client_id", "https://graph.instagram.com/v23.0/access_token", "GET", { ...base, client_id: appId }],
    // Some Instagram edges take the token as a Bearer header instead.
    ["IG v23.0 GET bearer", "https://graph.instagram.com/v23.0/access_token", "GET_BEARER", { grant_type: "ig_exchange_token", client_secret: secret }],
    // The Facebook host serves an oauth/access_token edge; worth one shot. It
    // requires client_id (it answered "Missing client_id parameter" without),
    // and it names the param fb_exchange_token rather than access_token.
    [
      "FB v23.0 oauth GET",
      "https://graph.facebook.com/v23.0/oauth/access_token",
      "GET",
      { grant_type: "ig_exchange_token", client_id: appId, client_secret: secret, access_token: token },
    ],
    [
      "FB v23.0 fb_exchange",
      "https://graph.facebook.com/v23.0/oauth/access_token",
      "GET",
      { grant_type: "fb_exchange_token", client_id: appId, client_secret: secret, fb_exchange_token: token },
    ],
    // And the refresh grant, in case the code-exchange token is already long.
    ["IG v23.0 refresh GET", "https://graph.instagram.com/v23.0/refresh_access_token", "GET", { grant_type: "ig_refresh_token", access_token: token }],
    ["IG unversioned refresh GET", "https://graph.instagram.com/refresh_access_token", "GET", { grant_type: "ig_refresh_token", access_token: token }],
  ];

  console.log("[instagram login] --- probing long-lived exchange variants (temporary diagnostic) ---");
  for (const [label, url, method, params] of candidates) {
    const qs = new URLSearchParams(params);
    try {
      let res;
      if (method === "GET") {
        res = await fetch(`${url}?${qs}`);
      } else if (method === "GET_BEARER") {
        res = await fetch(`${url}?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      } else {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: qs,
        });
      }
      const raw = await res.text();
      let msg = raw;
      try {
        const j = JSON.parse(raw);
        // Never print the token: report only whether one came back.
        msg = j?.access_token
          ? `SUCCESS access_token returned, expires_in=${j.expires_in ?? "(none)"}`
          : j?.error?.message || j?.error_message || raw;
      } catch {
        /* keep raw */
      }
      console.log(`[instagram login]   ${res.ok && /SUCCESS/.test(msg) ? "==> WORKS" : "        fail"}  ${label.padEnd(26)} HTTP ${res.status}  ${String(msg).slice(0, 160)}`);
    } catch (e) {
      console.log(`[instagram login]           fail  ${label.padEnd(26)} network: ${e.message}`);
    }
  }
  console.log("[instagram login] --- end probe ---");
}

// ── Step 3: short-lived → long-lived (60 days) ───────────────────────────

export async function exchangeForLongLivedInstagramToken(shortLivedToken) {
  if (!shortLivedToken) {
    throw new Error("Instagram long-lived token exchange failed. — no short-lived token to exchange.");
  }

  // .trim() matters here even though instagramLoginConfigured() already trims:
  // that check reads the var, this one SENDS it. A trailing newline in the
  // server's .env would otherwise travel into client_secret and Meta's
  // complaint would name the method or the request, never the whitespace.
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: (process.env.INSTAGRAM_APP_SECRET || "").trim(),
    access_token: String(shortLivedToken).trim(),
  });

  // Documented as GET (and GET is what works). But this exact call has been
  // seen to come back with Meta's "Unsupported request - method type: get"
  // (2026-08-27, live connect attempt), and probing the endpoint shows it
  // accepts POST with the same parameters. So: try GET, and if Meta rejects the
  // METHOD specifically, retry once as POST rather than failing the connect.
  // Any other error is returned as-is — a bad secret must not be retried into
  // looking like a method problem.
  const attempt = async (method) => {
    const res =
      method === "GET"
        ? await fetch(`${GRAPH_HOST}/${API_VERSION}/access_token?${params}`)
        : await fetch(`${GRAPH_HOST}/${API_VERSION}/access_token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params,
          });
    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, raw };
  };

  const out = await attempt("GET");
  if (out.ok && out.data?.access_token) {
    return { accessToken: out.data.access_token, expiresIn: Number(out.data.expires_in) || null, grant: "ig_exchange_token" };
  }

  // Both GET and POST come back `IGApiException` "Unsupported request - method
  // type: <method>" on a REAL token (observed live 2026-08-27, fbtrace
  // A59HM2lzQjZRzqUiYhzRs_S). That is not a method problem: the same endpoint
  // answers a deliberately invalid token with `OAuthException` "Failed to
  // decode" instead, which means Meta only reaches "unsupported" AFTER it has
  // successfully decoded the token and seen what kind it is. So the grant does
  // not apply to this token — the Business Login code exchange has evidently
  // already returned a long-lived token, making short→long meaningless.
  //
  // `ig_refresh_token` is the grant for a token that is ALREADY long-lived, so
  // try that: between them the two grants cover both possible states, and we
  // still try the documented one first.
  console.warn(
    `[instagram login] ig_exchange_token rejected (${out.status}: ${String(out.raw).slice(0, 200)}) — ` +
      `token is likely already long-lived; trying ig_refresh_token.`,
  );

  try {
    const refreshed = await refreshInstagramToken(shortLivedToken);
    console.log("[instagram login] ig_refresh_token succeeded — the code-exchange token was already long-lived.");
    return { ...refreshed, grant: "ig_refresh_token" };
  } catch (e) {
    // Neither grant worked. Do NOT fail the connect over this: the token we
    // already hold is valid right now, and refusing it would block the account
    // entirely over a token-lifetime optimisation. Hand it back with an unknown
    // expiry — cron.refreshTokens() treats a null token_expires_at as due, so
    // it will retry daily and record what it finds.
    console.error(
      `[instagram login] both ig_exchange_token and ig_refresh_token failed (${e.message}). ` +
        `Proceeding with the code-exchange token; expiry unknown, the daily refresh cron will retry.`,
    );
    // TEMPORARY: identify the variant Meta accepts, using the real token. This
    // is the only place that token exists. Remove with probeLongLivedVariants().
    // Deliberately best-effort — a probe must never be what breaks a connect.
    try {
      await probeLongLivedVariants(shortLivedToken);
    } catch (probeError) {
      console.warn(`[instagram login] variant probe itself failed: ${probeError.message}`);
    }
    return { accessToken: shortLivedToken, expiresIn: null, grant: "none" };
  }
}

// ── Step 4 (recurring): refresh before the 60 days run out ───────────────

// Only works while the token is STILL VALID and at least 24 hours old, and only
// if instagram_business_basic was granted. There is no recovery once a token
// has actually expired — the account has to be reconnected by hand — which is
// why the cron sweep runs daily with a wide margin instead of cutting it fine.
export async function refreshInstagramToken(longLivedToken) {
  if (!longLivedToken) throw new Error("Instagram token refresh failed. — no token to refresh.");

  const params = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: String(longLivedToken).trim(),
  });
  const res = await fetch(`${GRAPH_HOST}/${API_VERSION}/refresh_access_token?${params}`);
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!res.ok || !data?.access_token) {
    // This runs unattended in the daily cron, so the raw body is the only
    // record of why an account is drifting toward an unrecoverable expiry.
    console.error(`[instagram login] token refresh failed (HTTP ${res.status}): ${String(raw).slice(0, 500)}`);
    throw new Error(oauthErrorMessage(data, "Instagram token refresh failed."));
  }
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || null };
}

// ── Profile ──────────────────────────────────────────────────────────────

// Who did we just connect? Also the account-type gate: Meta hands out tokens
// for personal profiles too, and the publish call is what fails later with
// something unhelpful. Checking here means the user is told the real problem
// ("switch to a Creator account") at connect time instead of on their first
// failed post.
//
// `user_id` is the id publishing endpoints want; `id` is the app-scoped id.
// They differ, so prefer user_id and only fall back to id.
export async function fetchInstagramProfile(accessToken) {
  const params = new URLSearchParams({
    fields: "user_id,username,name,account_type,profile_picture_url,followers_count,media_count",
    access_token: accessToken,
  });
  const res = await fetch(`${GRAPH_HOST}/${API_VERSION}/me?${params}`);
  const data = await res.json();
  if (!res.ok || (!data?.user_id && !data?.id)) {
    throw new Error(oauthErrorMessage(data, "Couldn't read the Instagram profile."));
  }

  return {
    igUserId: String(data.user_id || data.id),
    username: data.username || null,
    name: data.name || data.username || "Instagram account",
    accountType: data.account_type || null,
    avatar: data.profile_picture_url || null,
    followers: Number.isFinite(data.followers_count) ? data.followers_count : null,
    mediaCount: Number.isFinite(data.media_count) ? data.media_count : null,
  };
}

// Meta's account_type vocabulary on this path is BUSINESS | MEDIA_CREATOR, and
// older/edge responses have used CREATOR. PERSONAL is the one that can't
// publish. An absent value is treated as fine: the field is not formally
// guaranteed, and refusing a connect over a missing field would block accounts
// that actually work.
export function isProfessionalAccount(accountType) {
  if (!accountType) return true;
  return String(accountType).toUpperCase() !== "PERSONAL";
}
