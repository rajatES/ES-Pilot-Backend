// Shared normalization for the post fields every write path has to agree on
// (composer, Developer API, CSV import, queue). These rules used to live in the
// composer's own React code, which meant a post created through the API silently
// skipped them: an API caller could send an unknown content_type, and — the
// reason this file exists — sending a linkUrl with contentType "lic" produced a
// post with no comment at all, because the "put the link in the first comment"
// setting was only ever applied client-side.
//
// The caller passes its own supabase client (as computeAutoApproveAt does), so
// this module has no imports and stays trivially testable.

// ── Content type ────────────────────────────────────────────────────────────
// The vocabulary the composer's dropdown, the compliance check, and the team
// stats tables all count on. "lic" = link in comment.
export const CONTENT_TYPES = ["infographic", "meme_image", "lic"];
export const CONTENT_TYPES_HINT = "infographic, meme_image, lic, or leave blank";

// Canonical form — trimmed and lowercased, "" when unset.
export function normalizeContentType(raw) {
  return (raw ?? "").toString().trim().toLowerCase();
}

// Unset is valid: content type is required by the composer's own CTA guard and
// flagged by compliance, but it is not a hard write-time constraint (CSV import
// and the API both allow blank).
export function isValidContentType(value) {
  return !value || CONTENT_TYPES.includes(value);
}

// ── Tags ────────────────────────────────────────────────────────────────────
// Free-form per-post editorial tags ("nascar", "daytona"). Lives here rather
// than in the composer for the same reason everything else in this file does:
// an API or CSV caller must produce identical rows to the UI.
//
// Normalized hard, because these are meant to be grouped and filtered later and
// "NASCAR", "nascar " and "#nascar" arriving as three different tags would make
// every count wrong:
//   - trimmed, lowercased
//   - a leading "#" stripped (people type hashtags out of habit)
//   - de-duplicated, order preserved
//   - blanks dropped
// Accepts either an array or a comma-separated string, so a CSV column and a
// JSON array both work.
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

export function normalizeTags(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const out = [];
  for (const item of list) {
    const tag = String(item ?? "")
      .trim()
      .replace(/^#+/, "")
      .trim()
      .toLowerCase()
      .slice(0, MAX_TAG_LENGTH);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// ── First comment ───────────────────────────────────────────────────────────
// Meta down-ranks captions that carry an outbound link, so the house style is to
// publish the link as the first comment instead — "link in comment", the `lic`
// content type. Settings → "Link in first comment" turns that on for the whole
// workspace.
//
// NOTE: this COPIES the link into the comment; it does not remove it from the
// caption. `post.link_url` is still folded into the caption text by facebook.js /
// threads.js / x.js / youtube.js (or rendered as FB's link card), so with the
// setting on the link goes out in both places — which does not achieve the
// down-ranking dodge that motivates LIC. Instagram is the exception: it ignores
// link_url on the caption side. The only way to get a genuinely link-free caption
// today is to leave linkUrl empty and put the URL in firstComment. Changing that
// would alter how existing posts publish, so it is deliberately left as-is and
// documented in README-api.md instead.
//
// Appending is idempotent: the composer still appends client-side before it
// POSTs (so it keeps working against an older backend), and a link already
// present in the text is never added twice. Composer and API therefore produce
// the same string for the same input.
export function composeFirstComment({ firstComment, linkUrl, appendLink }) {
  let fc = (firstComment ?? "").toString().trim();
  const link = (linkUrl ?? "").toString().trim();
  if (appendLink && link && !fc.includes(link)) {
    fc = fc ? `${fc}\n${link}` : link;
  }
  return fc || null;
}

// Workspace default for the above. Defaults to OFF.
export async function linkInFirstCommentEnabled(supabase, ownerId) {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("user_id", ownerId)
    .eq("key", "app")
    .maybeSingle();
  return !!data?.value?.defaultLinkInFirstComment;
}

// Convenience for the single-post write paths. `linkInComment` is the per-post
// override: undefined follows the workspace setting, true/false force it either
// way. Only the Developer API sets it — an automation that publishes both
// link-bearing articles and standalone graphics needs to decide per post, which
// one workspace-wide switch cannot express.
//
// The settings read is skipped entirely when there is no link to append, which
// is the common case for a plain post.
export async function resolveFirstComment(supabase, ownerId, { firstComment, linkUrl, linkInComment }) {
  const link = (linkUrl ?? "").toString().trim();
  if (!link || linkInComment === false) {
    return composeFirstComment({ firstComment, appendLink: false });
  }
  const appendLink = linkInComment === true || (await linkInFirstCommentEnabled(supabase, ownerId));
  return composeFirstComment({ firstComment, linkUrl: link, appendLink });
}
