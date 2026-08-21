// Per-platform content resolution for scheduled_posts rows. A post carries a
// master caption (`body`) plus optional per-platform overrides and options in
// the platform_captions / platform_options jsonb columns. Every publish path
// (posts.create, publish-now, cron, approvals) resolves through here so the
// four pipelines can't drift.

const PLATFORMS = ["facebook", "instagram", "threads", "twitter", "youtube"];
const FB_FORMATS = ["post", "reel", "story"];
const IG_FORMATS = ["feed", "reel"];
const YT_PRIVACY = ["public", "unlisted", "private"];
const X_REPLY = ["everyone", "following", "mentionedUsers", "subscribers", "verified"];

// Platforms that still have a NATIVE publish path. Threads and X were retired
// in favour of Postiz (2026-08-21), so an account on one of those platforms is
// only publishable when publish_via = "postiz".
const NATIVE_PLATFORMS = ["facebook", "instagram", "youtube"];

// Guard called at the top of every publish attempt.
//
// Each of the four publish paths dispatches through an if/else (or ternary)
// chain whose FINAL branch is Facebook. That was safe while every platform had
// its own branch, but retiring the native Threads and X branches turned the
// fallback into a trap: an account on a retired platform with publish_via
// "native" would silently take the Facebook branch and try to post with the
// wrong token to the wrong place. This makes that state a clear, catchable
// error instead — the target fails with a message that says what to do.
export function assertPublishable(account) {
  if (!account?.platform) throw new Error("This account has no platform set.");
  if (account.publish_via === "postiz") return;
  if (NATIVE_PLATFORMS.includes(account.platform)) return;
  throw new Error(
    `${account.display_name || account.platform} can't publish: ${account.platform} now publishes through Postiz. ` +
      `Re-import this account from Accounts → Connect → Import from Postiz.`,
  );
}

// Caption for a platform: trimmed override, else the master body.
export function resolveCaption(post, platform) {
  const override = post?.platform_captions?.[platform];
  return typeof override === "string" && override.trim() ? override.trim() : post?.body || "";
}

export function platformOptions(post, platform) {
  return post?.platform_options?.[platform] || {};
}

// Facebook publish format for this post: post (default) | reel | story.
export function fbFormat(post) {
  const f = platformOptions(post, "facebook").format;
  return FB_FORMATS.includes(f) ? f : "post";
}

export function igFormat(post) {
  const f = platformOptions(post, "instagram").format;
  return IG_FORMATS.includes(f) ? f : "feed";
}

// A post-like object with the caption swapped for the platform's — what the
// platform libs receive, so they stay override-agnostic.
export function postForPlatform(post, platform) {
  return { ...post, body: resolveCaption(post, platform) };
}

// Sanitize client/API-supplied per-platform fields before persisting: only
// known platforms, only known option shapes, empty values dropped. Returns
// null when nothing valid remains (column stays NULL for plain posts).
export function sanitizePlatformCaptions(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (const p of PLATFORMS) {
    if (typeof input[p] === "string" && input[p].trim()) out[p] = input[p].trim();
  }
  return Object.keys(out).length ? out : null;
}

export function sanitizePlatformOptions(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  const fb = input.facebook || {};
  if (FB_FORMATS.includes(fb.format) && fb.format !== "post") out.facebook = { format: fb.format };
  const ig = input.instagram || {};
  if (IG_FORMATS.includes(ig.format) && ig.format !== "feed") out.instagram = { format: ig.format };
  const yt = input.youtube || {};
  const ytOut = {};
  if (typeof yt.title === "string" && yt.title.trim()) ytOut.title = yt.title.trim().slice(0, 100);
  if (YT_PRIVACY.includes(yt.privacy) && yt.privacy !== "public") ytOut.privacy = yt.privacy;
  if (Object.keys(ytOut).length) out.youtube = ytOut;
  // X options are consumed by lib/postiz.js buildSettings(). Only non-default
  // values are stored, so a plain tweet leaves the column NULL as before.
  const tw = input.twitter || {};
  const twOut = {};
  if (X_REPLY.includes(tw.whoCanReply) && tw.whoCanReply !== "everyone") twOut.whoCanReply = tw.whoCanReply;
  if (typeof tw.community === "string" && /^https:\/\/x\.com\/i\/communities\//.test(tw.community.trim())) {
    twOut.community = tw.community.trim();
  }
  if (tw.madeWithAi === true) twOut.madeWithAi = true;
  if (tw.paidPartnership === true) twOut.paidPartnership = true;
  if (Object.keys(twOut).length) out.twitter = twOut;
  return Object.keys(out).length ? out : null;
}
