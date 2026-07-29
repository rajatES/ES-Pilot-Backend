// Meta Threads API (graph.threads.net). Separate OAuth and app credentials
// from the Facebook Graph API. Tokens are per-profile, ~60 days, refreshable
// after 24h. Publishing is container-based; no native scheduling, so the cron
// queue publishes at post time.

const THREADS_GRAPH = "https://graph.threads.net/v1.0";
const THREADS_AUTH = "https://threads.net/oauth/authorize";

const SCOPES = "threads_basic,threads_content_publish,threads_manage_replies,threads_manage_insights";

// One env switch drives mock mode for every platform (see lib/facebook.js).
function isMockMode() {
  return (process.env.FACEBOOK_PUBLISH_MODE || "").trim().toLowerCase() !== "live";
}

function mockId(prefix) {
  return `${prefix}_mock_${Math.random().toString(36).slice(2, 10)}`;
}

export function threadsConfigured() {
  return !!(process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET);
}

export function threadsRedirectUri() {
  return process.env.THREADS_REDIRECT_URI || "http://localhost:4000/api/auth/threads/callback";
}

// Threads has no link field; it previews the first URL found in the text.
function appendLink(text, link) {
  if (!link || (text && text.includes(link))) return text;
  return text ? `${text}\n\n${link}` : link;
}

// ── OAuth ────────────────────────────────────────────────────────────────

export function buildThreadsAuthUrl({ state }) {
  const params = new URLSearchParams({
    client_id: process.env.THREADS_APP_ID,
    redirect_uri: threadsRedirectUri(),
    scope: SCOPES,
    response_type: "code",
    state
  });
  return `${THREADS_AUTH}?${params}`;
}

// code → short-lived token (+ the Threads user id).
export async function exchangeThreadsCode(code) {
  const res = await fetch(`${THREADS_GRAPH}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.THREADS_APP_ID,
      client_secret: process.env.THREADS_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: threadsRedirectUri(),
      code
    })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || data?.error_message || "Threads code exchange failed.");
  }
  return { accessToken: data.access_token, threadsUserId: String(data.user_id) };
}

// short-lived → long-lived (~60 days). Returns { accessToken, expiresAt }.
export async function exchangeForLongLivedThreadsToken(shortToken) {
  const params = new URLSearchParams({
    grant_type: "th_exchange_token",
    client_secret: process.env.THREADS_APP_SECRET,
    access_token: shortToken
  });
  const res = await fetch(`${THREADS_GRAPH}/access_token?${params}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Threads long-lived token exchange failed.");
  }
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in || 60 * 86400) * 1000).toISOString()
  };
}

// Refresh a long-lived token (must be ≥24h old and unexpired).
export async function refreshThreadsToken(accessToken) {
  const params = new URLSearchParams({ grant_type: "th_refresh_token", access_token: accessToken });
  const res = await fetch(`${THREADS_GRAPH}/refresh_access_token?${params}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Threads token refresh failed.");
  }
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in || 60 * 86400) * 1000).toISOString()
  };
}

export async function fetchThreadsProfile(accessToken) {
  const params = new URLSearchParams({
    fields: "id,username,name,threads_profile_picture_url",
    access_token: accessToken
  });
  const res = await fetch(`${THREADS_GRAPH}/me?${params}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Couldn't read the Threads profile.");
  }
  return {
    id: String(data.id),
    username: data.username,
    name: data.name || data.username,
    avatar: data.threads_profile_picture_url || null
  };
}

// ── Publishing ───────────────────────────────────────────────────────────

// Containers (especially video) process asynchronously — poll until FINISHED.
async function waitForContainer(containerId, accessToken, { timeoutMs = 3 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const params = new URLSearchParams({ fields: "status,error_message", access_token: accessToken });
    const res = await fetch(`${THREADS_GRAPH}/${containerId}?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || "Threads container status check failed.");
    if (data.status === "FINISHED") return;
    if (data.status === "ERROR" || data.status === "EXPIRED") {
      throw new Error(data.error_message || `Threads media processing ${data.status.toLowerCase()}.`);
    }
    if (Date.now() > deadline) throw new Error("Threads media processing timed out.");
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function createContainer(threadsUserId, accessToken, fields) {
  const res = await fetch(`${THREADS_GRAPH}/${threadsUserId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, access_token: accessToken })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Threads container creation failed.");
  }
  return data.id;
}

// Publish a Threads post. post.media is the ordered [{url, type}] array
// (may be empty → text post). Returns { externalPostId }.
export async function publishThreadsPost({ account, post }) {
  if (isMockMode()) {
    return { externalPostId: mockId(account.external_account_id || "threads") };
  }
  if (!account.access_token) throw new Error("Threads access token is missing.");

  const uid = account.external_account_id;
  const token = account.access_token;
  const text = appendLink(post.body || "", post.link_url);
  const media = Array.isArray(post.media) && post.media.length
    ? post.media
    : post.image_url ? [{ url: post.image_url, type: "image" }] : [];

  let containerId;

  if (media.length === 0) {
    if (!text.trim()) throw new Error("Threads posts need text or media.");
    containerId = await createContainer(uid, token, { media_type: "TEXT", text });
  } else if (media.length === 1) {
    const m = media[0];
    containerId = await createContainer(uid, token, {
      media_type: m.type === "video" ? "VIDEO" : "IMAGE",
      [m.type === "video" ? "video_url" : "image_url"]: m.url,
      text
    });
    if (m.type === "video") await waitForContainer(containerId, token);
  } else {
    // Carousel: 2–20 children, each its own container flagged is_carousel_item.
    const childIds = [];
    for (const m of media.slice(0, 20)) {
      const childId = await createContainer(uid, token, {
        media_type: m.type === "video" ? "VIDEO" : "IMAGE",
        [m.type === "video" ? "video_url" : "image_url"]: m.url,
        is_carousel_item: "true"
      });
      if (m.type === "video") await waitForContainer(childId, token);
      childIds.push(childId);
    }
    containerId = await createContainer(uid, token, {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      text
    });
  }

  // Give even image containers a moment on first try, then publish.
  await waitForContainer(containerId, token, { timeoutMs: 60 * 1000 }).catch(() => { /* some containers report FINISHED only after publish attempt — proceed */ });

  const res = await fetch(`${THREADS_GRAPH}/${uid}/threads_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: containerId, access_token: token })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Threads publish failed.");
  }
  return { externalPostId: data.id };
}

// "First comment" equivalent: a text reply to our own just-published thread.
export async function postThreadsReply({ account, mediaId, message }) {
  if (!message?.trim()) return { skipped: true };
  if (isMockMode()) return { commentId: mockId("reply") };
  if (!account.access_token) throw new Error("Threads access token is missing.");

  const uid = account.external_account_id;
  const containerId = await createContainer(uid, account.access_token, {
    media_type: "TEXT",
    text: message.trim(),
    reply_to_id: mediaId
  });
  const res = await fetch(`${THREADS_GRAPH}/${uid}/threads_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: containerId, access_token: account.access_token })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data?.error?.message || "Threads reply failed.");
  return { commentId: data.id };
}

// ── Sync helpers ─────────────────────────────────────────────────────────

// Does the thread still exist? { exists: true } | { exists: false } | { exists: null, error }
export async function checkThreadsPostStatus({ account, externalPostId }) {
  if (isMockMode() || externalPostId.includes("_mock_")) return { exists: true };
  if (!account.access_token) return { exists: null, error: "No access token." };

  const params = new URLSearchParams({ fields: "id", access_token: account.access_token });
  const res = await fetch(`${THREADS_GRAPH}/${externalPostId}?${params}`);
  const data = await res.json();
  if (res.ok && !data.error) return { exists: true };

  const code = data?.error?.code;
  if (code === 10 || code === 100 || code === 803) {
    // Control check: if /me is readable the token is fine → post really gone.
    const meRes = await fetch(`${THREADS_GRAPH}/me?fields=id&access_token=${account.access_token}`);
    if (meRes.ok) return { exists: false };
    return { exists: null, error: "Cannot verify — Threads profile unreadable with this token." };
  }
  return { exists: null, error: data?.error?.message || "Unknown Threads API error." };
}

// Engagement metrics for a published thread.
export async function getThreadsPostMetrics({ account, externalPostId }) {
  if (isMockMode() || externalPostId.includes("_mock_")) {
    return { likes: 0, comments: 0, shares: 0, impressions: null, reach: null, raw: {} };
  }
  if (!account.access_token) throw new Error("Threads access token is missing.");

  const params = new URLSearchParams({
    metric: "views,likes,replies,reposts,quotes",
    access_token: account.access_token
  });
  const res = await fetch(`${THREADS_GRAPH}/${externalPostId}/insights?${params}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Couldn't fetch Threads metrics.");
  }

  const byName = {};
  for (const m of data.data || []) {
    byName[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
  }
  return {
    likes: byName.likes ?? 0,
    comments: byName.replies ?? 0,
    replies: byName.replies ?? null,
    // reposts + quotes are Threads' "shares" equivalent.
    shares: (byName.reposts ?? 0) + (byName.quotes ?? 0),
    impressions: byName.views ?? null,
    reach: null,
    raw: data
  };
}
