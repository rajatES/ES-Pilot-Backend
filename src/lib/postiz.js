// Postiz — publishing bridge for the platforms our own Meta apps can't reach:
// **Threads** (Meta's Threads API needs its own app plus review, which we never
// completed) and **personal / standalone Instagram** (the native path requires
// an IG Business or Creator account linked to a Facebook Page, so a personal
// profile structurally cannot be connected through it).
//
// Postiz owns the OAuth and the platform tokens for these channels; we hold a
// single workspace API key. An account routed through here is a normal
// `social_accounts` row with `publish_via = "postiz"`, its `platform` still the
// real platform ("threads" / "instagram") so the composer, previews, validation
// and analytics keep treating it like any other account. `external_account_id`
// holds the Postiz *integration* id and `metadata.postiz.provider` the Postiz
// provider identifier, which is what `settings.__type` needs at publish time.
//
// Scheduling stays OURS. We always call Postiz with type:"now", fired by
// /api/cron/publish when a target's time arrives — the same decision made for
// Facebook in 2026-07: whoever owns the publish moment also owns whether the
// approval gate was honoured, and that has to be us.
//
// API reference: https://docs.postiz.com/public-api/introduction

import { createServiceSupabase } from "./supabaseServer";

const DEFAULT_BASE = "https://api.postiz.com/public/v1";

// Postiz provider identifiers we know how to drive, mapped to the platform
// value the rest of the app uses. Anything else in the workspace is ignored on
// import rather than half-supported.
export const POSTIZ_PROVIDERS = {
  threads: "threads",
  instagram: "instagram",
  "instagram-standalone": "instagram",
};

function baseUrl() {
  return (process.env.POSTIZ_API_URL || DEFAULT_BASE).replace(/\/$/, "");
}

export function postizConfigured() {
  return !!(process.env.POSTIZ_API_KEY || "").trim();
}

// Same global switch the Meta/X/YouTube libs read, so a dev machine can't post
// to a real Threads/Instagram profile by accident. Named for Facebook purely
// for historical reasons — it has always gated every platform.
function isMockMode() {
  return (process.env.FACEBOOK_PUBLISH_MODE || "").trim().toLowerCase() !== "live";
}

function mockId(prefix) {
  return `${prefix}_mock_${Math.random().toString(36).slice(2, 10)}`;
}

// One place that talks to Postiz. Postiz sends the API key raw in the
// Authorization header — NOT as a Bearer token; adding the prefix 401s.
async function postizFetch(path, { method = "GET", body, timeoutMs = 120000 } = {}) {
  const key = (process.env.POSTIZ_API_KEY || "").trim();
  if (!key) throw new Error("Postiz is not configured — set POSTIZ_API_KEY in the backend environment.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: key,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`Postiz request timed out (${method} ${path}).`);
    throw new Error(`Couldn't reach Postiz: ${e.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) throw new Error(postizErrorMessage(res.status, data, `${method} ${path}`));
  return data;
}

// Turn a Postiz error response into something a user can act on. The status
// code carries most of the meaning (documented in their API overview), and the
// body shape is inconsistent — sometimes {message}, sometimes {error}, sometimes
// a validation array — so try each before falling back to the status alone.
function postizErrorMessage(status, data, context) {
  const detail =
    (typeof data === "string" && data.trim()) ||
    data?.message ||
    data?.error ||
    (Array.isArray(data?.errors) ? data.errors.map((e) => e?.message || e).join("; ") : "") ||
    "";
  const suffix = detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : "";

  if (status === 401) return `Postiz rejected the API key (401)${suffix}`;
  if (status === 403) return `Postiz denied access to this resource (403)${suffix}`;
  if (status === 404) return `Postiz resource not found (404)${suffix}`;
  if (status === 413) return `Postiz rejected the upload as too large (413)${suffix}`;
  if (status === 429) return `Postiz rate limit hit (429) — the create-post limit is ~100/hour${suffix}`;
  if (status >= 500) return `Postiz server error (${status})${suffix}`;
  return `Postiz request failed (${status}) on ${context}${suffix}`;
}

// ── Workspace / channel discovery ────────────────────────────────────────

// Is the configured key live? Used by the Accounts UI to explain an empty list.
export async function postizPing() {
  const data = await postizFetch("/is-connected");
  return { connected: data?.connected !== false };
}

// Channels ("integrations") in the Postiz workspace, narrowed to the providers
// we support. `platform` is what the row would be created as in our schema.
export async function listPostizIntegrations() {
  const data = await postizFetch("/integrations");
  const rows = Array.isArray(data) ? data : data?.integrations || [];
  return rows
    .filter((r) => r?.id && POSTIZ_PROVIDERS[r.identifier])
    .map((r) => ({
      id: r.id,
      name: r.name || r.profile || "Untitled channel",
      provider: r.identifier,
      platform: POSTIZ_PROVIDERS[r.identifier],
      picture: r.picture || null,
      profile: r.profile || null,
      disabled: !!r.disabled,
      customer: r.customer?.name || null,
    }));
}

// ── Media ────────────────────────────────────────────────────────────────

// Our media already sits on a public S3 URL, which is exactly what Postiz's
// upload-from-url wants — so nothing is re-uploaded through this backend.
// Returns { id, path } for the create-post `image` array.
async function ingestMedia(url) {
  const data = await postizFetch("/upload-from-url", { method: "POST", body: { url } });
  if (!data?.id) throw new Error("Postiz accepted the media URL but returned no file id.");
  return { id: data.id, path: data.path || url };
}

// ── Publishing ───────────────────────────────────────────────────────────

// Postiz has no "comment on an existing post" endpoint: extra entries in a
// post's `value` array ARE the comment/thread chain, submitted with the post.
// So the first comment has to ride along with the publish call — which is why
// publishPostizPost takes it as an argument and reports back that it handled
// it, instead of the caller posting it separately afterwards.
function buildValue({ caption, media, firstComment }) {
  const value = [{ content: caption || "", image: media }];
  // Instagram comments can't carry media, and a Threads reply has none of its
  // own here either — text only in both cases.
  if (firstComment?.trim()) value.push({ content: firstComment.trim(), image: [] });
  return value;
}

// Per-provider `settings` object. Threads takes nothing beyond __type;
// Instagram (both business-linked and standalone) needs a post_type.
function buildSettings({ provider, platform, igFormat }) {
  const settings = { __type: provider };
  if (platform === "instagram") {
    // Our composer offers Feed | Reel; Postiz calls those "post" and "reel".
    settings.post_type = igFormat === "reel" ? "reel" : "post";
    settings.collaborators = [];
  }
  return settings;
}

// Ordered media for a post — same normalization the other platform libs do.
function postMedia(post) {
  if (Array.isArray(post.media) && post.media.length) return post.media;
  if (post.image_url) return [{ url: post.image_url, type: "image" }];
  return [];
}

// Publish immediately through Postiz. Returns
// { externalPostId, firstCommentIncluded } — the flag tells the calling publish
// path to SKIP its own first-comment step (see buildValue above).
export async function publishPostizPost({ account, post, options = {}, firstComment = "" }) {
  const provider = account?.metadata?.postiz?.provider;
  if (!provider) {
    throw new Error(
      `${account?.display_name || "This account"} is missing its Postiz provider — re-import it from Accounts.`,
    );
  }
  const platform = POSTIZ_PROVIDERS[provider] || account.platform;
  const media = postMedia(post);

  // Instagram requires media on every post type; Threads is happy with text.
  if (platform === "instagram" && !media.length) {
    throw new Error("Instagram posts require an image or video.");
  }

  if (isMockMode()) {
    return { externalPostId: mockId(provider), firstCommentIncluded: !!firstComment?.trim() };
  }

  const integrationId = account.external_account_id;
  if (!integrationId) throw new Error("This account has no Postiz integration id — re-import it from Accounts.");

  // Hand Postiz our public S3 URLs; it stores its own copy and gives us ids.
  const uploaded = [];
  for (const m of media) {
    if (!m?.url) continue;
    uploaded.push(await ingestMedia(m.url));
  }

  const created = await postizFetch("/posts", {
    method: "POST",
    body: {
      type: "now",
      // Ignored for type:"now", but the payload schema expects the field.
      date: new Date().toISOString(),
      // Our own UTM helper may already have rewritten the link; don't let Postiz
      // reshorten it, or the utm_* params we appended stop being attributable.
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: integrationId },
          value: buildValue({ caption: post.body || "", media: uploaded, firstComment }),
          settings: buildSettings({ provider, platform, igFormat: options.format }),
        },
      ],
    },
  });

  // Documented response: [{ postId, integration }].
  const row = Array.isArray(created) ? created[0] : created?.posts?.[0] || created;
  const externalPostId = row?.postId || row?.id;
  if (!externalPostId) {
    throw new Error("Postiz accepted the post but returned no post id, so it can't be tracked.");
  }
  return { externalPostId, firstCommentIncluded: !!firstComment?.trim() };
}

// ── Status ───────────────────────────────────────────────────────────────

// Postiz exposes no get-post-by-id, only a date-windowed list — so look the
// post up in a window around when we sent it.
//
// Returns { found, state, permalink, error }. Deliberately NOT the { exists }
// contract the native libs use: a post missing from Postiz means it was deleted
// *in Postiz*, which says nothing about whether it is still live on Threads or
// Instagram. Treating that as "deleted on platform" would invent deletions —
// the same false-positive class that bit auto-optimized Facebook reels. Callers
// use this for the permalink and to notice state === "ERROR".
export async function getPostizPostState({ externalPostId, sentAt }) {
  if (isMockMode() || String(externalPostId).includes("_mock_")) {
    return { found: true, state: "PUBLISHED", permalink: null, error: null };
  }

  const anchor = sentAt ? new Date(sentAt).getTime() : Date.now();
  const pad = 2 * 86400000; // ±2 days covers clock skew and late publishes
  const params = new URLSearchParams({
    startDate: new Date(anchor - pad).toISOString(),
    endDate: new Date(anchor + pad).toISOString(),
  });

  let data;
  try {
    data = await postizFetch(`/posts?${params}`);
  } catch (e) {
    return { found: null, state: null, permalink: null, error: e.message };
  }

  const posts = Array.isArray(data) ? data : data?.posts || [];
  const match = posts.find((p) => String(p?.id) === String(externalPostId));
  if (!match) return { found: false, state: null, permalink: null, error: null };

  return {
    found: true,
    state: match.state || null,
    permalink: match.releaseURL || null,
    error: match.state === "ERROR" ? "Postiz reported this post as failed on the platform." : null,
  };
}

// Reconcile one postiz-backed post_target against Postiz. Called from both
// verify paths (the manual POST /api/posts/verify and the verify-posts cron) so
// they can't drift, and best-effort throughout: a Postiz outage must not break
// a verify sweep that is mostly about Facebook.
//
// What it does: records the permalink once Postiz publishes (which is often a
// little after we got the post id back), and turns a Postiz-side ERROR into a
// failed target so it stops showing as delivered. What it deliberately does NOT
// do is mark anything deleted — see getPostizPostState.
export async function reconcilePostizTarget(target) {
  try {
    const state = await getPostizPostState({
      externalPostId: target.external_post_id,
      sentAt: target.sent_at,
    });

    const patch = { last_verified_at: new Date().toISOString() };
    if (state.permalink && state.permalink !== target.permalink) patch.permalink = state.permalink;
    if (state.state === "ERROR") {
      patch.status = "failed";
      patch.last_error = state.error;
    }

    const supabase = createServiceSupabase();
    await supabase.from("post_targets").update(patch).eq("id", target.id);
    return { failed: state.state === "ERROR", permalink: patch.permalink || null };
  } catch (e) {
    console.warn(`[postiz] reconcile failed for target ${target.id}:`, e.message);
    return { failed: false, permalink: null };
  }
}

// ── Metrics ──────────────────────────────────────────────────────────────

// Postiz returns analytics as a list of named series rather than fixed fields:
//   [{ label: "Likes", data: [{ total, date }], percentageChange }]
// The labels are not documented per platform, so match them loosely and keep
// the whole response in `raw` — a metric we fail to recognise is then still
// recoverable from the stored row instead of being silently lost.
const METRIC_LABELS = [
  [/^(likes?|reactions?|favou?rites?)$/, "likes"],
  [/^(comments?)$/, "comments"],
  [/^(shares?|reposts?|retweets?)$/, "shares"],
  [/^(impressions?|views?|plays?|video views?)$/, "impressions"],
  [/^(reach|accounts reached)$/, "reach"],
  [/^(saved?|saves|bookmarks?)$/, "saves"],
  [/^(repl(y|ies))$/, "replies"],
  [/^(follows?|followers?|new followers?)$/, "follows"],
  [/^(clicks?|link clicks?|profile clicks?)$/, "clicks"],
  [/^(total interactions?|engagements?|interactions?)$/, "total_interactions"],
  [/^(viewers?|unique viewers?)$/, "viewers"],
];

function metricKeyFor(label) {
  const norm = String(label || "").trim().toLowerCase();
  for (const [re, key] of METRIC_LABELS) if (re.test(norm)) return key;
  return null;
}

// A series is a dated run of totals. For a per-post lifetime counter the most
// recent point is the current value, so take the latest date rather than
// summing (summing a cumulative series would multiply it).
function latestTotal(series) {
  if (!Array.isArray(series) || !series.length) return null;
  const sorted = [...series].sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")));
  const v = Number(sorted[sorted.length - 1]?.total);
  return Number.isFinite(v) ? v : null;
}

// Metrics for a Postiz-published post, in the shape buildPostInsightRow wants.
export async function getPostizPostMetrics({ externalPostId, days = 30 }) {
  const empty = {
    likes: null, comments: null, shares: null, impressions: null, reach: null,
    viewers: null, clicks: null, saves: null, total_interactions: null,
    replies: null, follows: null, raw: {},
  };
  if (isMockMode() || String(externalPostId).includes("_mock_")) return { ...empty, raw: { mock: true } };

  const data = await postizFetch(`/analytics/post/${encodeURIComponent(externalPostId)}?date=${days}`);
  const series = Array.isArray(data) ? data : data?.analytics || [];
  const out = { ...empty, raw: { postiz: series } };

  for (const s of series) {
    const key = metricKeyFor(s?.label);
    if (!key) continue;
    const value = latestTotal(s?.data);
    if (value != null) out[key] = value;
  }
  return out;
}

// ── Deletion ─────────────────────────────────────────────────────────────

// Remove the post from Postiz. A 404 means it is already gone, which is the
// outcome we wanted, so it is not an error.
export async function deletePostizPost({ externalPostId }) {
  if (isMockMode() || String(externalPostId).includes("_mock_")) return { deleted: true, mocked: true };
  try {
    await postizFetch(`/posts/${encodeURIComponent(externalPostId)}`, { method: "DELETE" });
    return { deleted: true };
  } catch (e) {
    if (/\(404\)/.test(e.message)) return { deleted: true, alreadyGone: true };
    throw e;
  }
}
