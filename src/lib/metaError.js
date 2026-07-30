// Shared Graph API error formatter for the Facebook + Instagram libs (both hit
// graph.facebook.com and return the same error envelope).
//
// Meta collapses many distinct failures into the generic "Invalid parameter"
// (code 100) — useless on its own. The actionable reason lives in
// error_user_title / error_user_msg / error_subcode (e.g. subcode 1366046 +
// "Bad Image" when a photo/video URL can't be fetched or is too large). Surface
// those so a failed post says WHY, not just "Invalid parameter". Falls back to
// error.message, then the caller's default.
export function metaErrorMessage(data, fallback) {
  const e = data?.error;
  if (!e) return fallback;
  const human = [e.error_user_title, e.error_user_msg].filter(Boolean).join(" — ");
  const base = human || e.message || fallback;
  const code = e.code != null ? `#${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""}` : "";
  const withCode = code && !base.includes(`#${e.code}`) ? `${base} (${code})` : base;
  return e.fbtrace_id ? `${withCode} [trace ${e.fbtrace_id}]` : withCode;
}
