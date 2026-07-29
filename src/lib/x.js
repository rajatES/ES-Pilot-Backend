// X API v2, OAuth 2.0 user context with PKCE. Access tokens last ~2h and
// refresh tokens rotate on every refresh, so tokens are refreshed just-in-time
// and the rotated pair is persisted immediately. Media uses the chunked
// INIT/APPEND/FINALIZE protocol. No native scheduling; the cron queue
// publishes at post time.

import { createServiceSupabase } from "./supabaseServer";

const X_API = "https://api.x.com/2";
const X_AUTH = "https://x.com/i/oauth2/authorize";

const SCOPES = "tweet.read tweet.write users.read media.write offline.access";
const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB APPEND chunks

function isMockMode() {
  return (process.env.FACEBOOK_PUBLISH_MODE || "").trim().toLowerCase() !== "live";
}

function mockId(prefix) {
  return `${prefix}_mock_${Math.random().toString(36).slice(2, 10)}`;
}

export function xConfigured() {
  return !!process.env.X_CLIENT_ID;
}

export function xRedirectUri() {
  return process.env.X_REDIRECT_URI || "http://localhost:4000/api/auth/x/callback";
}

// X auto-shortens links (t.co); append to the text.
function appendLink(text, link) {
  if (!link || (text && text.includes(link))) return text;
  return text ? `${text}\n\n${link}` : link;
}

// Confidential clients (Web App type) authenticate token calls with Basic auth.
function tokenAuthHeaders() {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (process.env.X_CLIENT_SECRET) {
    const basic = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
}

// ── OAuth ────────────────────────────────────────────────────────────────

export function buildXAuthUrl({ state, codeChallenge }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.X_CLIENT_ID,
    redirect_uri: xRedirectUri(),
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });
  return `${X_AUTH}?${params}`;
}

export async function exchangeXCode({ code, codeVerifier }) {
  const res = await fetch(`${X_API}/oauth2/token`, {
    method: "POST",
    headers: tokenAuthHeaders(),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: xRedirectUri(),
      code_verifier: codeVerifier,
      client_id: process.env.X_CLIENT_ID
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error_description || data?.error || "X code exchange failed.");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + (data.expires_in || 7200) * 1000).toISOString()
  };
}

export async function fetchXProfile(accessToken) {
  const res = await fetch(`${X_API}/users/me?user.fields=profile_image_url,name,username`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  if (!res.ok || !data.data) {
    throw new Error(data?.errors?.[0]?.detail || data?.detail || "Couldn't read the X profile.");
  }
  return {
    id: String(data.data.id),
    username: data.data.username,
    name: data.data.name || data.data.username,
    avatar: data.data.profile_image_url || null
  };
}

// Returns a valid access token, refreshing when expired or near expiry.
// Mutates `account` so multi-step flows reuse the fresh token.
export async function getFreshXAccessToken(account) {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_token && expiresAt > Date.now() + 5 * 60 * 1000) {
    return account.access_token;
  }
  if (!account.refresh_token) {
    throw new Error("X connection expired — reconnect the account.");
  }

  const res = await fetch(`${X_API}/oauth2/token`, {
    method: "POST",
    headers: tokenAuthHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
      client_id: process.env.X_CLIENT_ID
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      data?.error === "invalid_grant"
        ? "X connection expired — reconnect the account."
        : data?.error_description || "X token refresh failed."
    );
  }

  const fresh = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || account.refresh_token,
    token_expires_at: new Date(Date.now() + (data.expires_in || 7200) * 1000).toISOString()
  };

  // Persist immediately: losing a rotated refresh token orphans the connection.
  if (account.id) {
    try {
      const supabase = createServiceSupabase();
      await supabase.from("social_accounts").update(fresh).eq("id", account.id);
    } catch (e) {
      console.error("[x] failed to persist refreshed tokens:", e.message);
    }
  }

  Object.assign(account, fresh);
  return fresh.access_token;
}

// ── Media upload (v2 chunked) ────────────────────────────────────────────

async function uploadXMedia(accessToken, mediaUrl, type) {
  const fileRes = await fetch(mediaUrl);
  if (!fileRes.ok) throw new Error(`Couldn't download media (${fileRes.status}).`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const mimeType = fileRes.headers.get("content-type") || (type === "video" ? "video/mp4" : "image/jpeg");
  const auth = { Authorization: `Bearer ${accessToken}` };

  // INIT
  const initRes = await fetch(`${X_API}/media/upload`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      command: "INIT",
      total_bytes: String(buffer.byteLength),
      media_type: mimeType,
      media_category: type === "video" ? "tweet_video" : "tweet_image"
    })
  });
  const initData = await initRes.json();
  const mediaId = initData?.data?.id || initData?.media_id_string || initData?.id;
  if (!initRes.ok || !mediaId) {
    throw new Error(initData?.errors?.[0]?.detail || initData?.detail || "X media INIT failed.");
  }

  // APPEND in chunks
  for (let i = 0; i * CHUNK_SIZE < buffer.byteLength; i++) {
    const chunk = buffer.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, buffer.byteLength));
    const form = new FormData();
    form.append("command", "APPEND");
    form.append("media_id", String(mediaId));
    form.append("segment_index", String(i));
    form.append("media", new Blob([chunk]), "chunk");
    const appendRes = await fetch(`${X_API}/media/upload`, { method: "POST", headers: auth, body: form });
    if (!appendRes.ok && appendRes.status !== 204) {
      const d = await appendRes.json().catch(() => ({}));
      throw new Error(d?.errors?.[0]?.detail || `X media APPEND failed (${appendRes.status}).`);
    }
  }

  // FINALIZE
  const finRes = await fetch(`${X_API}/media/upload`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ command: "FINALIZE", media_id: String(mediaId) })
  });
  const finData = await finRes.json();
  if (!finRes.ok) {
    throw new Error(finData?.errors?.[0]?.detail || finData?.detail || "X media FINALIZE failed.");
  }

  // Videos process asynchronously — poll STATUS until succeeded.
  let processing = finData?.data?.processing_info || finData?.processing_info;
  const deadline = Date.now() + 4 * 60 * 1000;
  while (processing && processing.state !== "succeeded") {
    if (processing.state === "failed") {
      throw new Error(processing.error?.message || "X video processing failed.");
    }
    if (Date.now() > deadline) throw new Error("X video processing timed out.");
    await new Promise((r) => setTimeout(r, (processing.check_after_secs || 3) * 1000));
    const stRes = await fetch(`${X_API}/media/upload?command=STATUS&media_id=${mediaId}`, { headers: auth });
    const stData = await stRes.json();
    if (!stRes.ok) throw new Error(stData?.errors?.[0]?.detail || "X media STATUS check failed.");
    processing = stData?.data?.processing_info || stData?.processing_info || null;
  }

  return String(mediaId);
}

// ── Publishing ───────────────────────────────────────────────────────────

// X posts allow up to 4 images OR one video — not a mix.
export async function publishXPost({ account, post }) {
  if (isMockMode()) {
    return { externalPostId: mockId(account.external_account_id || "x") };
  }

  const media = Array.isArray(post.media) && post.media.length
    ? post.media
    : post.image_url ? [{ url: post.image_url, type: "image" }] : [];
  const videos = media.filter((m) => m.type === "video");
  const images = media.filter((m) => m.type !== "video");
  if (videos.length > 1 || (videos.length && images.length)) {
    throw new Error("X posts support up to 4 images OR one video — not both.");
  }

  const text = appendLink(post.body || "", post.link_url);
  if (!text.trim() && !media.length) throw new Error("X posts need text or media.");

  const accessToken = await getFreshXAccessToken(account);

  const mediaIds = [];
  for (const m of videos.length ? videos : images.slice(0, 4)) {
    mediaIds.push(await uploadXMedia(accessToken, m.url, m.type));
  }

  const payload = { text };
  if (mediaIds.length) payload.media = { media_ids: mediaIds };

  const res = await fetch(`${X_API}/tweets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok || !data.data?.id) {
    throw new Error(data?.errors?.[0]?.detail || data?.detail || "X post failed.");
  }
  return { externalPostId: data.data.id };
}

// "First comment" equivalent — a reply to our own just-published post.
export async function postXReply({ account, tweetId, message }) {
  if (!message?.trim()) return { skipped: true };
  if (isMockMode()) return { commentId: mockId("reply") };

  const accessToken = await getFreshXAccessToken(account);
  const res = await fetch(`${X_API}/tweets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: message.trim(), reply: { in_reply_to_tweet_id: tweetId } })
  });
  const data = await res.json();
  if (!res.ok || !data.data?.id) {
    throw new Error(data?.errors?.[0]?.detail || "X reply failed.");
  }
  return { commentId: data.data.id };
}

// ── Sync helpers ─────────────────────────────────────────────────────────

export async function checkXPostStatus({ account, externalPostId }) {
  if (isMockMode() || externalPostId.includes("_mock_")) return { exists: true };
  try {
    const accessToken = await getFreshXAccessToken(account);
    const res = await fetch(`${X_API}/tweets/${externalPostId}?tweet.fields=id`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (res.ok && data.data?.id) return { exists: true };
    // v2 reports missing/deleted tweets as 200 + errors[] (type not-found).
    const err = data?.errors?.[0];
    if (err && /not.?found|deleted/i.test(`${err.title} ${err.type} ${err.detail}`)) {
      return { exists: false };
    }
    return { exists: null, error: err?.detail || data?.detail || "Unknown X API error." };
  } catch (e) {
    return { exists: null, error: e.message };
  }
}

export async function getXPostMetrics({ account, externalPostId }) {
  if (isMockMode() || externalPostId.includes("_mock_")) {
    return { likes: 0, comments: 0, shares: 0, impressions: null, reach: null, raw: {} };
  }
  const accessToken = await getFreshXAccessToken(account);
  const res = await fetch(`${X_API}/tweets/${externalPostId}?tweet.fields=public_metrics`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  const m = data?.data?.public_metrics;
  if (!res.ok || !m) {
    throw new Error(data?.errors?.[0]?.detail || "Couldn't fetch X metrics.");
  }
  return {
    likes: m.like_count ?? 0,
    comments: m.reply_count ?? 0,
    replies: m.reply_count ?? null,
    shares: (m.retweet_count ?? 0) + (m.quote_count ?? 0),
    impressions: m.impression_count ?? null,
    reach: null,
    raw: m
  };
}
