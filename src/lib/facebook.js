// Keep the Graph version in lockstep with lib/instagram.js and lib/facebookOAuth.js.
const GRAPH = "https://graph.facebook.com/v23.0";

// Mock unless explicitly "live" (case-insensitive), so a fresh checkout never
// hits the real APIs by accident.
function isMockMode() {
  return (process.env.FACEBOOK_PUBLISH_MODE || "").trim().toLowerCase() !== "live";
}

function mockPostId(prefix) {
  return `${prefix}_mock_${Math.random().toString(36).slice(2, 10)}`;
}

// Appends a link to the caption/message text so Facebook auto-linkifies it —
// used where the target Graph API endpoint has no dedicated "link" field.
function appendLink(text, link) {
  if (!link || (text && text.includes(link))) return text;
  return text ? `${text}\n\n${link}` : link;
}

// Normalize a post's media into the ordered [{url, type}] array. Older rows
// (and CSV imports) only carry image_url — treat that as a one-image array.
function postMedia(post) {
  if (Array.isArray(post.media) && post.media.length) return post.media;
  if (post.image_url) return [{ url: post.image_url, type: "image" }];
  return [];
}

// Upload one photo unpublished so it can be referenced via attached_media
// without creating its own story. Returns the photo id.
async function uploadUnpublishedPhoto(pageId, accessToken, imageUrl) {
  const res = await fetch(`${GRAPH}/${pageId}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: imageUrl, published: false, access_token: accessToken })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Photo upload failed.");
  return data.id;
}

// Publish immediately to a Facebook Page feed or photos endpoint.
export async function publishFacebookPost({ account, post }) {
  if (isMockMode()) {
    return { externalPostId: mockPostId(account.external_account_id || "page") };
  }

  if (!account.access_token) {
    throw new Error("Facebook Page access token is missing.");
  }

  const pageId = account.external_account_id;
  const media = postMedia(post);
  const videos = media.filter((m) => m.type === "video");
  const images = media.filter((m) => m.type !== "video");

  // Facebook feed posts can carry ONE video or up to 10 photos — not a mix.
  if (videos.length > 1 || (videos.length && images.length)) {
    throw new Error("Facebook posts support one video OR up to 10 images — not both.");
  }

  if (videos.length === 1) {
    // Native video post via /videos (file_url must be a downloadable video).
    const res = await fetch(`${GRAPH}/${pageId}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_url: videos[0].url,
        description: appendLink(post.body, post.link_url),
        published: true,
        access_token: account.access_token
      })
    });
    return parseFbResponse(res);
  }

  if (images.length === 1) {
    // /photos has no "link" field, so the link is folded into the caption.
    // published:true is explicit: an unpublished photo is a dark post only
    // Page admins can see.
    const res = await fetch(`${GRAPH}/${pageId}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: images[0].url,
        caption: appendLink(post.body, post.link_url),
        published: true,
        access_token: account.access_token
      })
    });
    return parseFbResponse(res);
  }

  if (images.length > 1) {
    // Multi-photo (carousel) post: upload each photo unpublished, then one
    // /feed post referencing them all via attached_media.
    const mediaIds = [];
    for (const img of images.slice(0, 10)) {
      mediaIds.push(await uploadUnpublishedPhoto(pageId, account.access_token, img.url));
    }
    const res = await fetch(`${GRAPH}/${pageId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: appendLink(post.body, post.link_url),
        attached_media: mediaIds.map((id) => ({ media_fbid: id })),
        published: true,
        access_token: account.access_token
      })
    });
    return parseFbResponse(res);
  }

  const payload = { message: post.body, access_token: account.access_token };
  if (post.link_url) payload.link = post.link_url;

  const res = await fetch(`${GRAPH}/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseFbResponse(res);
}

// Schedule a post via Facebook's native scheduled_publish_time.
// scheduledFor must be a JS Date between 10 minutes and 30 days from now.
// Returns { externalPostId, mode: "scheduled" } on success.
export async function scheduleFacebookPost({ account, post, scheduledFor }) {
  if (isMockMode()) {
    return { externalPostId: mockPostId(account.external_account_id || "page"), mode: "scheduled" };
  }

  if (!account.access_token) {
    throw new Error("Facebook Page access token is missing.");
  }

  const pageId = account.external_account_id;
  const unixTimestamp = Math.floor(new Date(scheduledFor).getTime() / 1000);
  const media = postMedia(post);
  const videos = media.filter((m) => m.type === "video");
  const images = media.filter((m) => m.type !== "video");

  if (videos.length > 1 || (videos.length && images.length)) {
    throw new Error("Facebook posts support one video OR up to 10 images — not both.");
  }

  if (videos.length === 1) {
    // /videos supports native scheduling directly.
    const res = await fetch(`${GRAPH}/${pageId}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_url: videos[0].url,
        description: appendLink(post.body, post.link_url),
        published: false,
        scheduled_publish_time: unixTimestamp,
        access_token: account.access_token
      })
    });
    const result = await parseFbResponse(res);
    return { ...result, mode: "scheduled" };
  }

  const payload = {
    message: post.body,
    published: false,
    scheduled_publish_time: unixTimestamp,
    access_token: account.access_token
  };

  if (images.length) {
    // Scheduled photo posts: upload each photo unpublished, then create the
    // scheduled /feed post referencing them via attached_media.
    const mediaIds = [];
    for (const img of images.slice(0, 10)) {
      mediaIds.push(await uploadUnpublishedPhoto(pageId, account.access_token, img.url));
    }
    payload.attached_media = mediaIds.map((id) => ({ media_fbid: id }));
    // Photo feed posts have no "link" field — fold the link into the caption
    // text (same behavior as immediate photo posts).
    payload.message = appendLink(post.body, post.link_url);
  } else if (post.link_url) {
    // Text/link post: "link" drives the preview card Facebook renders.
    payload.link = post.link_url;
  }

  const res = await fetch(`${GRAPH}/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const result = await parseFbResponse(res);
  return { ...result, mode: "scheduled" };
}

// Force-publish a scheduled post Facebook failed to auto-publish (a stuck
// dark post, invisible to everyone except Page admins).
export async function publishUnpublishedFacebookPost({ account, externalPostId }) {
  if (isMockMode()) return { ok: true };
  if (!account.access_token) throw new Error("Facebook Page access token is missing.");

  const res = await fetch(`${GRAPH}/${externalPostId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_published: true, access_token: account.access_token })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Failed to publish the unpublished post.");
  return { ok: true };
}

// Update an already-scheduled (unpublished) Facebook post — caption and/or time.
export async function updateScheduledFacebookPost({ account, externalPostId, message, scheduledFor }) {
  if (isMockMode()) return { ok: true };

  if (!account.access_token) throw new Error("Facebook Page access token is missing.");

  const payload = { access_token: account.access_token };
  if (message !== undefined) payload.message = message;
  if (scheduledFor) payload.scheduled_publish_time = Math.floor(new Date(scheduledFor).getTime() / 1000);

  const res = await fetch(`${GRAPH}/${externalPostId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Failed to update scheduled Facebook post.");
  return { ok: true };
}

// Post a first comment on an already-published Facebook post.
// Best-effort helper — callers should treat failures as non-fatal.
export async function postFacebookComment({ account, postId, message }) {
  if (!message?.trim()) return { skipped: true };
  if (isMockMode()) return { commentId: mockPostId("comment") };

  if (!account.access_token) throw new Error("Facebook Page access token is missing.");

  const res = await fetch(`${GRAPH}/${postId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: message.trim(), access_token: account.access_token })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Failed to post first comment.");
  return { commentId: data.id };
}

// Fetch engagement metrics for a published Page post. Likes/comments/shares
// come from the object itself (works with the page token); impressions/reach
// need the read_insights permission, so they're best-effort and may be null.
export async function getFacebookPostMetrics({ account, externalPostId }) {
  if (isMockMode() || externalPostId.includes("_mock_")) {
    return { likes: 0, comments: 0, shares: 0, impressions: null, reach: null, raw: {} };
  }
  if (!account.access_token) throw new Error("Facebook Page access token is missing.");

  const params = new URLSearchParams({
    fields: "likes.summary(true).limit(0),comments.summary(true).limit(0),shares",
    access_token: account.access_token
  });
  const res = await fetch(`${GRAPH}/${externalPostId}?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Couldn't fetch post metrics.");

  const metrics = {
    likes: data.likes?.summary?.total_count ?? 0,
    comments: data.comments?.summary?.total_count ?? 0,
    shares: data.shares?.count ?? 0,
    impressions: null,
    reach: null,
    raw: data
  };

  try {
    const iRes = await fetch(
      `${GRAPH}/${externalPostId}/insights?metric=post_impressions,post_impressions_unique&access_token=${account.access_token}`
    );
    const iData = await iRes.json();
    if (iRes.ok) {
      for (const m of iData.data || []) {
        const v = m.values?.[0]?.value;
        if (m.name === "post_impressions") metrics.impressions = v ?? null;
        if (m.name === "post_impressions_unique") metrics.reach = v ?? null;
      }
    }
  } catch { /* insights are optional — token may lack read_insights */ }

  return metrics;
}

// Check whether a published/scheduled post still exists on Facebook.
// Returns { exists: true, isPublished } | { exists: false } | { exists: null, error }
// (null = couldn't determine — e.g. expired token — so callers shouldn't flag it).
export async function checkFacebookPostStatus({ account, externalPostId }) {
  if (isMockMode() || externalPostId.includes("_mock_")) {
    return { exists: true, isPublished: true };
  }
  if (!account.access_token) return { exists: null, error: "No access token." };

  // message is returned too so the sync cron can detect captions edited
  // directly on Facebook and pull them back into the app.
  const params = new URLSearchParams({ fields: "id,is_published,message", access_token: account.access_token });
  const res = await fetch(`${GRAPH}/${externalPostId}?${params}`);
  const data = await res.json();

  if (res.ok) return { exists: true, isPublished: data.is_published !== false, remoteMessage: data.message ?? null };

  const code = data?.error?.code;
  // Codes 10 and 100 both mean "does not exist OR missing permission" —
  // deliberately ambiguous. Control check: if the same token can read the
  // page's own feed, permissions are fine, so the post really is gone.
  if (code === 10 || code === 100) {
    const feedRes = await fetch(
      `${GRAPH}/${account.external_account_id}/feed?limit=1&access_token=${account.access_token}`
    );
    if (feedRes.ok) return { exists: false };
    return { exists: null, error: "Cannot verify — page feed is unreadable with this token." };
  }
  // Anything else (190 expired token, rate limits…) is indeterminate.
  return { exists: null, error: data?.error?.message || "Unknown Graph API error." };
}

async function parseFbResponse(res) {
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || "Facebook API request failed.");
  }
  return { externalPostId: data.post_id || data.id };
}

// ── Reels & Stories ──────────────────────────────────────────────────────────
// Both use a start → upload (rupload.facebook.com, header-based file_url) →
// finish flow. Neither supports native scheduling (Stories have no
// scheduled_publish_time at all; scheduled Reels create dark-post recovery
// problems), so scheduled reels/stories go through the cron queue like IG.

const RUPLOAD = "https://rupload.facebook.com";

// Upload a hosted video to an upload session. rupload uses HEADERS (not a
// JSON body) and the "OAuth" auth scheme — unlike everything else here.
async function ruploadHostedFile(kind, videoId, accessToken, fileUrl) {
  const res = await fetch(`${RUPLOAD}/${kind}/${videoId}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${accessToken}`, file_url: fileUrl },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(data?.debug_info?.message || data?.error?.message || "Video upload to Facebook failed.");
  }
}

// Poll a video's processing status until it's ready (mirrors the IG
// waitForContainer pattern).
async function waitForVideoReady(videoId, accessToken, { timeoutMs = 4 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const params = new URLSearchParams({ fields: "status", access_token: accessToken });
    const res = await fetch(`${GRAPH}/${videoId}?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || "Couldn't check the video's processing status.");
    const status = data?.status?.video_status;
    if (status === "ready") return;
    if (status === "error") throw new Error("Facebook failed to process the video.");
    if (Date.now() > deadline) throw new Error("Timed out waiting for Facebook to process the video.");
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// Publish a Reel to a Facebook Page. Requires exactly one video in the post
// media. Returns { externalPostId } (the reel's video id).
export async function publishFacebookReel({ account, post }) {
  if (isMockMode()) {
    return { externalPostId: mockPostId("reel") };
  }
  if (!account.access_token) throw new Error("Facebook Page access token is missing.");

  const pageId = account.external_account_id;
  const video = postMedia(post).find((m) => m.type === "video");
  if (!video) throw new Error("A Facebook Reel needs exactly one video.");

  // 1. Start an upload session.
  const startRes = await fetch(`${GRAPH}/${pageId}/video_reels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upload_phase: "start", access_token: account.access_token }),
  });
  const start = await startRes.json();
  if (!startRes.ok || !start.video_id) {
    throw new Error(start?.error?.message || "Couldn't start the Reel upload.");
  }

  // 2. Hand Facebook the hosted file URL.
  await ruploadHostedFile("video_reels", start.video_id, account.access_token, video.url);

  // 3. Finish + publish with the caption.
  const finishRes = await fetch(`${GRAPH}/${pageId}/video_reels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      upload_phase: "finish",
      video_id: start.video_id,
      video_state: "PUBLISHED",
      description: appendLink(post.body, post.link_url),
      access_token: account.access_token,
    }),
  });
  const finish = await finishRes.json();
  if (!finishRes.ok || finish?.success === false) {
    throw new Error(finish?.error?.message || "Couldn't publish the Reel.");
  }

  // 4. Wait for processing so the verify cron doesn't race an "uploading" reel.
  await waitForVideoReady(start.video_id, account.access_token).catch((e) => {
    // Publishing succeeded — processing lag is not a failure.
    console.warn(`[facebook] reel ${start.video_id} still processing:`, e.message);
  });

  return { externalPostId: start.video_id };
}

// Publish a Story to a Facebook Page from the post's single media item.
// Photo stories reuse the unpublished-photo upload; video stories use the
// start/rupload/finish flow. Stories expire after 24h and have no comments.
export async function publishFacebookStory({ account, post }) {
  if (isMockMode()) {
    return { externalPostId: mockPostId("story") };
  }
  if (!account.access_token) throw new Error("Facebook Page access token is missing.");

  const pageId = account.external_account_id;
  const media = postMedia(post)[0];
  if (!media) throw new Error("A Facebook Story needs one image or video.");

  if (media.type !== "video") {
    // Photo story: upload unpublished, then attach to /photo_stories.
    const photoId = await uploadUnpublishedPhoto(pageId, account.access_token, media.url);
    const res = await fetch(`${GRAPH}/${pageId}/photo_stories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_id: photoId, access_token: account.access_token }),
    });
    const data = await res.json();
    if (!res.ok || data?.success === false) {
      throw new Error(data?.error?.message || "Couldn't publish the photo Story.");
    }
    return { externalPostId: data.post_id || photoId };
  }

  // Video story: start → rupload → finish.
  const startRes = await fetch(`${GRAPH}/${pageId}/video_stories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upload_phase: "start", access_token: account.access_token }),
  });
  const start = await startRes.json();
  if (!startRes.ok || !start.video_id) {
    throw new Error(start?.error?.message || "Couldn't start the video Story upload.");
  }

  await ruploadHostedFile("video_stories", start.video_id, account.access_token, media.url);

  const finishRes = await fetch(`${GRAPH}/${pageId}/video_stories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upload_phase: "finish", video_id: start.video_id, access_token: account.access_token }),
  });
  const finish = await finishRes.json();
  if (!finishRes.ok || finish?.success === false) {
    throw new Error(finish?.error?.message || "Couldn't publish the video Story.");
  }

  return { externalPostId: finish.post_id || start.video_id };
}
