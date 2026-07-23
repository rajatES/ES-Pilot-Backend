const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
// Uploads use a DIFFERENT base path than metadata calls — /upload/youtube/v3.
const YOUTUBE_UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Mirrors lib/facebook.js — one switch drives mock mode for every platform.
function isMockMode() {
  return (process.env.FACEBOOK_PUBLISH_MODE || "").trim().toLowerCase() !== "live";
}

// Get OAuth access token using refresh token
export async function getYouTubeAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new Error("YouTube refresh token is missing.");
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    body: params
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error_description || "Failed to refresh YouTube token.");
  }

  return data.access_token;
}

// Publish a video: download from storage, resumable-upload to YouTube, set an
// optional thumbnail from the first attached image. With scheduledFor the
// video uploads private with status.publishAt (native scheduling); otherwise
// it publishes public immediately.
export async function publishYouTubeVideo({ account, post, scheduledFor, options = {} }) {
  const media = Array.isArray(post.media) && post.media.length
    ? post.media
    : post.image_url ? [{ url: post.image_url, type: "image" }] : [];
  const video = media.find((m) => m.type === "video");
  if (!video) {
    throw new Error("YouTube posts require a video — attach one or deselect the YouTube channel.");
  }

  if (isMockMode()) {
    return { externalPostId: `yt_mock_${Math.random().toString(36).slice(2, 10)}` };
  }

  const accessToken = await getYouTubeAccessToken(account.refresh_token);

  // Title = explicit per-platform option, else first line of the caption
  // (YouTube caps titles at 100 chars); description = full caption + link.
  const title = (options.title || "").trim().slice(0, 100)
    || (post.body || "").split("\n")[0].slice(0, 100)
    || "Untitled Video";
  let description = post.body || "";
  if (post.link_url && !description.includes(post.link_url)) {
    description = description ? `${description}\n\n${post.link_url}` : post.link_url;
  }

  // Native scheduling requires "private" until publishAt fires; otherwise
  // honor the requested privacy (default public).
  const privacy = ["public", "unlisted", "private"].includes(options.privacy) ? options.privacy : "public";
  const metadata = {
    snippet: { title, description, categoryId: "22" },
    status: {
      privacyStatus: scheduledFor ? "private" : privacy,
      selfDeclaredMadeForKids: false,
      ...(scheduledFor ? { publishAt: new Date(scheduledFor).toISOString() } : {})
    }
  };

  // 1. Download the stored video.
  const fileRes = await fetch(video.url);
  if (!fileRes.ok) throw new Error(`Couldn't download the video file (${fileRes.status}).`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const contentType = fileRes.headers.get("content-type") || "video/mp4";

  // 2. Start the resumable session (note the /upload/... base path).
  const initRes = await fetch(`${YOUTUBE_UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Upload-Content-Type": contentType,
      "X-Upload-Content-Length": String(buffer.byteLength)
    },
    body: JSON.stringify(metadata)
  });
  if (!initRes.ok) {
    const data = await initRes.json().catch(() => ({}));
    throw new Error(data?.error?.message || "Failed to start the YouTube upload.");
  }
  const sessionUri = initRes.headers.get("location");
  if (!sessionUri) throw new Error("No upload session URI returned from YouTube.");

  // 3. Upload the bytes (single request; files are capped at 200MB).
  const uploadRes = await fetch(sessionUri, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(buffer.byteLength) },
    body: buffer
  });
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || !uploadData.id) {
    throw new Error(uploadData?.error?.message || "YouTube video upload failed.");
  }
  const videoId = uploadData.id;

  // 4. Best-effort thumbnail (needs a phone-verified channel; never fatal).
  const thumb = media.find((m) => m.type === "image");
  if (thumb) {
    try {
      const tRes = await fetch(thumb.url);
      if (tRes.ok) {
        const tBuf = Buffer.from(await tRes.arrayBuffer());
        await fetch(`${YOUTUBE_UPLOAD_API}/thumbnails/set?videoId=${videoId}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": tRes.headers.get("content-type") || "image/jpeg",
            "Content-Length": String(tBuf.byteLength)
          },
          body: tBuf
        });
      }
    } catch (e) {
      console.warn("[youtube] thumbnail set failed:", e.message);
    }
  }

  return { externalPostId: videoId };
}

// Get video metadata and status
export async function getYouTubeVideoStatus({ account, videoId }) {
  const accessToken = await getYouTubeAccessToken(account.refresh_token);

  const params = new URLSearchParams({
    part: "snippet,status,fileDetails",
    id: videoId
  });

  const res = await fetch(`${YOUTUBE_API}/videos?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const data = await res.json();
  if (!res.ok) {
    const code = data?.error?.code;
    // 404 = not found, 403 = forbidden
    if (code === 404 || code === 403) {
      return { exists: false, deleted: true };
    }
    return { exists: null, error: data?.error?.message || "Unknown error." };
  }

  const video = data.items?.[0];
  if (!video) return { exists: false, deleted: true };

  return {
    exists: true,
    deleted: false,
    title: video.snippet?.title,
    description: video.snippet?.description,
    status: video.status?.privacyStatus,
    uploadStatus: video.status?.uploadStatus, // processing, succeeded, failed
    publishAt: video.status?.publishAt,
    viewCount: video.statistics?.viewCount || 0,
    likeCount: video.statistics?.likeCount || 0,
    commentCount: video.statistics?.commentCount || 0,
    isPublished: video.status?.privacyStatus === "public"
  };
}

// Check if video still exists (for deletion detection)
export async function checkYouTubeVideoStatus({ account, videoId }) {
  if (videoId.includes("_mock_")) {
    return { exists: true, isPublished: true };
  }

  try {
    const result = await getYouTubeVideoStatus({ account, videoId });
    if (result.exists === false) {
      return { exists: false };
    }
    if (result.exists === null) {
      return { exists: null, error: result.error };
    }
    return { exists: true, isPublished: result.isPublished };
  } catch (err) {
    return { exists: null, error: err.message };
  }
}

// Get video analytics (views, engagement)
export async function getYouTubeVideoAnalytics({ account, videoId }) {
  const accessToken = await getYouTubeAccessToken(account.refresh_token);

  const params = new URLSearchParams({
    part: "statistics",
    id: videoId
  });

  const res = await fetch(`${YOUTUBE_API}/videos?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || "Failed to fetch video analytics.");
  }

  const stats = data.items?.[0]?.statistics || {};
  return {
    views: parseInt(stats.viewCount || 0),
    likes: parseInt(stats.likeCount || 0),
    comments: parseInt(stats.commentCount || 0),
    shares: 0, // YouTube API doesn't expose shares
    raw: stats
  };
}

// List user's channels
export async function getYouTubeChannels({ accessToken }) {
  const params = new URLSearchParams({
    part: "snippet,statistics",
    mine: true
  });

  const res = await fetch(`${YOUTUBE_API}/channels?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || "Failed to fetch channels.");
  }

  return (data.items || []).map((ch) => ({
    id: ch.id,
    title: ch.snippet?.title,
    thumbnail: ch.snippet?.thumbnails?.default?.url,
    subscribers: ch.statistics?.subscriberCount || "0",
    videoCount: ch.statistics?.videoCount || "0"
  }));
}

// Create YouTube OAuth authorization URL
export function getYouTubeAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.upload"
    ].join(" "),
    access_type: "offline",
    prompt: "consent"
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Exchange authorization code for tokens
export async function exchangeYouTubeCode(code) {
  const params = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
    grant_type: "authorization_code"
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    body: params
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error_description || "Failed to exchange YouTube code.");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in
  };
}
