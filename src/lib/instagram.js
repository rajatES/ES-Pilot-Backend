const GRAPH = "https://graph.facebook.com/v23.0";

// Defaults to mock unless explicitly set to "live" — mirrors lib/facebook.js.
function isMockMode() {
  return (process.env.FACEBOOK_PUBLISH_MODE || "").trim().toLowerCase() !== "live";
}

// Normalize a post's media into the ordered [{url, type}] array. Older rows
// only carry image_url — treat that as a one-image array.
function postMedia(post) {
  if (Array.isArray(post.media) && post.media.length) return post.media;
  if (post.image_url) return [{ url: post.image_url, type: "image" }];
  return [];
}

// Create one media container. Returns its id.
async function createContainer(igUserId, accessToken, fields) {
  const res = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...fields, access_token: accessToken })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Instagram media creation failed.");
  return data.id;
}

// Video containers process asynchronously — poll status_code until FINISHED.
async function waitForContainer(containerId, accessToken, { timeoutMs = 4 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const params = new URLSearchParams({ fields: "status_code,status", access_token: accessToken });
    const res = await fetch(`${GRAPH}/${containerId}?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || "Instagram container status check failed.");
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
      throw new Error(data.status || `Instagram media processing ${data.status_code.toLowerCase()}.`);
    }
    if (Date.now() > deadline) throw new Error("Instagram media processing timed out.");
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function publishContainer(igUserId, accessToken, creationId) {
  const res = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: creationId, access_token: accessToken })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Instagram publish failed.");
  return data.id;
}

// Publish to an Instagram Business/Creator account.
// IG requires media — text-only posts are not allowed. Container flow:
//   single image  → image container → publish
//   single video  → REELS container → poll until processed → publish
//   2-10 items    → child containers (is_carousel_item) → CAROUSEL container → publish
export async function publishInstagramPost({ account, post }) {
  const media = postMedia(post);
  if (!media.length) {
    throw new Error("Instagram posts require an image or video.");
  }

  if (isMockMode()) {
    return { externalPostId: `${account.external_account_id || "ig"}_mock_${Math.random().toString(36).slice(2, 10)}` };
  }

  if (!account.access_token) {
    throw new Error("Instagram access token is missing.");
  }

  const igUserId = account.external_account_id;
  const token = account.access_token;
  const caption = post.body || "";

  let creationId;

  if (media.length === 1) {
    const m = media[0];
    if (m.type === "video") {
      // Single videos publish as Reels (Meta's canonical video type; it also
      // appears in the main feed via share_to_feed).
      creationId = await createContainer(igUserId, token, {
        media_type: "REELS",
        video_url: m.url,
        share_to_feed: true,
        caption
      });
      await waitForContainer(creationId, token);
    } else {
      creationId = await createContainer(igUserId, token, { image_url: m.url, caption });
    }
  } else {
    // Carousel: 2–10 children.
    const childIds = [];
    for (const m of media.slice(0, 10)) {
      const fields = m.type === "video"
        ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: true }
        : { image_url: m.url, is_carousel_item: true };
      const childId = await createContainer(igUserId, token, fields);
      if (m.type === "video") await waitForContainer(childId, token);
      childIds.push(childId);
    }
    creationId = await createContainer(igUserId, token, {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      caption
    });
    await waitForContainer(creationId, token, { timeoutMs: 60 * 1000 }).catch(() => { /* image-only carousels often skip processing */ });
  }

  const externalPostId = await publishContainer(igUserId, token, creationId);
  return { externalPostId };
}

// Post a first comment on an already-published Instagram media object.
// Best-effort helper — callers should treat failures as non-fatal.
export async function postInstagramComment({ account, mediaId, message }) {
  if (!message?.trim()) return { skipped: true };
  if (isMockMode()) return { commentId: `comment_mock_${Math.random().toString(36).slice(2, 10)}` };

  if (!account.access_token) throw new Error("Instagram access token is missing.");

  const res = await fetch(`${GRAPH}/${mediaId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: message.trim(), access_token: account.access_token })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Failed to post first comment.");
  return { commentId: data.id };
}

// Engagement metrics for a published Instagram media object. Like/comment
// counts come from the object; reach/views need instagram_manage_insights and
// are best-effort (null when unavailable).
export async function getInstagramPostMetrics({ account, externalPostId }) {
  if (isMockMode() || externalPostId.includes("_mock_")) {
    return { likes: 0, comments: 0, shares: 0, impressions: null, reach: null, raw: {} };
  }
  if (!account.access_token) throw new Error("Instagram access token is missing.");

  const params = new URLSearchParams({
    fields: "like_count,comments_count",
    access_token: account.access_token
  });
  const res = await fetch(`${GRAPH}/${externalPostId}?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Couldn't fetch Instagram metrics.");

  const metrics = {
    likes: data.like_count ?? 0,
    comments: data.comments_count ?? 0,
    shares: 0,
    impressions: null,
    reach: null,
    raw: data
  };

  try {
    // "views" replaced "impressions" for media created after mid-2024.
    const iRes = await fetch(
      `${GRAPH}/${externalPostId}/insights?metric=reach,views,shares&access_token=${account.access_token}`
    );
    const iData = await iRes.json();
    if (iRes.ok) {
      for (const m of iData.data || []) {
        const v = m.values?.[0]?.value;
        if (m.name === "reach") metrics.reach = v ?? null;
        if (m.name === "views") metrics.impressions = v ?? null;
        if (m.name === "shares") metrics.shares = v ?? 0;
      }
    }
  } catch { /* insights are optional — token may lack instagram_manage_insights */ }

  return metrics;
}

// Check whether a published Instagram post still exists.
// Returns { exists: true } | { exists: false } | { exists: null, error }
export async function checkInstagramPostStatus({ account, externalPostId }) {
  if (isMockMode() || externalPostId.includes("_mock_")) {
    return { exists: true };
  }
  if (!account.access_token) return { exists: null, error: "No access token." };

  const params = new URLSearchParams({
    fields: "id,caption",
    access_token: account.access_token
  });
  const res = await fetch(`${GRAPH}/${externalPostId}?${params}`);
  const data = await res.json();

  if (res.ok) return { exists: true };

  const code = data?.error?.code;
  // Codes 10, 100, 803 = media not found or permission denied
  if (code === 10 || code === 100 || code === 803) {
    // Verify we can still read the account to confirm permissions are ok
    const accountRes = await fetch(
      `${GRAPH}/${account.external_account_id}?fields=id&access_token=${account.access_token}`
    );
    if (accountRes.ok) return { exists: false };
    return { exists: null, error: "Cannot verify — account is unreadable with this token." };
  }

  return { exists: null, error: data?.error?.message || "Unknown Graph API error." };
}
