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

// ── Classifying a failure as "this account needs a human" ──────────────────
//
// The publish paths only ever see the thrown Error's *message*, not the Graph
// envelope — but every Meta throw in facebook.js/instagram.js is formatted by
// metaErrorMessage() above, which always stamps "(#code)" or "(#code/subcode)".
// Parsing that back out is what lets a catch block tell a dead page token apart
// from an ordinary content rejection without rewriting ~25 throw sites.
export function parseMetaCode(message) {
  const m = /\(#(\d+)(?:\/(\d+))?\)/.exec(message || "");
  if (!m) return null;
  return { code: Number(m[1]), subcode: m[2] ? Number(m[2]) : null };
}

// Top-level codes that always mean the stored token can no longer act for this
// page — the fix is re-granting access, not editing the post.
//   190 OAuth token expired / invalidated / revoked
//   102 session invalid (user logged out or session killed)
//    10 permission denied
//   200 missing permission or Page task (e.g. no CREATE_CONTENT)
//   368 temporarily blocked for policy violations
// Deliberately NOT here: 100 (generic "Invalid parameter" — usually the media
// or payload), 1 (generic unknown, mostly transient), 3 (usually our own API
// misuse). Flagging those would mark healthy pages broken on a bad post.
const ACCOUNT_ACTION_CODES = new Set([190, 102, 10, 200, 368]);

// Subcodes that mean the same thing even when the top-level code is generic.
//   458 app not authorized · 459 checkpoint · 460 password changed
//   463 expired · 464 unconfirmed user · 467 invalid/session expired
//   492 the user is not an admin of the page any more
//   2424009 "your account is restricted from performing this action" — the
//     grantor's identity carries a restriction; re-granting from a healthy,
//     app-role-holding account clears it (see HANDOFF §5).
const ACCOUNT_ACTION_SUBCODES = new Set([458, 459, 460, 463, 464, 467, 492, 2424009]);

// True when a publish failure is about the ACCOUNT (its token/identity/
// permissions), not about this particular post's content.
export function requiresAccountAction(message) {
  const parsed = parseMetaCode(message);
  if (!parsed) return false;
  const { code, subcode } = parsed;
  if (subcode != null && ACCOUNT_ACTION_SUBCODES.has(subcode)) return true;
  if (ACCOUNT_ACTION_CODES.has(code)) return true;
  // Meta sometimes reports a restriction under the generic code 1 with no
  // subcode; the wording is distinctive enough to catch narrowly.
  if (code === 1 && /\brestrict(ion|ed)\b/i.test(message)) return true;
  return false;
}
