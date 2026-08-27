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
  const body = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    client_secret: process.env.INSTAGRAM_APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
    code,
  });

  const res = await fetch(`${TOKEN_HOST}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data?.access_token) {
    throw new Error(oauthErrorMessage(data, "Instagram rejected the authorization code."));
  }
  return {
    accessToken: data.access_token,
    // The Instagram-scoped user id. Kept as a fallback for the profile lookup,
    // which is the authoritative source for what we store.
    userId: data.user_id ? String(data.user_id) : null,
    permissions: data.permissions || null,
  };
}

// ── Step 3: short-lived → long-lived (60 days) ───────────────────────────

export async function exchangeForLongLivedInstagramToken(shortLivedToken) {
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: process.env.INSTAGRAM_APP_SECRET,
    access_token: shortLivedToken,
  });
  const res = await fetch(`${GRAPH_HOST}/access_token?${params}`);
  const data = await res.json();
  if (!res.ok || !data?.access_token) {
    throw new Error(oauthErrorMessage(data, "Instagram long-lived token exchange failed."));
  }
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || null };
}

// ── Step 4 (recurring): refresh before the 60 days run out ───────────────

// Only works while the token is STILL VALID and at least 24 hours old, and only
// if instagram_business_basic was granted. There is no recovery once a token
// has actually expired — the account has to be reconnected by hand — which is
// why the cron sweep runs daily with a wide margin instead of cutting it fine.
export async function refreshInstagramToken(longLivedToken) {
  const params = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: longLivedToken,
  });
  const res = await fetch(`${GRAPH_HOST}/refresh_access_token?${params}`);
  const data = await res.json();
  if (!res.ok || !data?.access_token) {
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
  const res = await fetch(`${GRAPH_HOST}/v23.0/me?${params}`);
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
