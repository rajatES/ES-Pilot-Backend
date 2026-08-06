// Account-level publish health.
//
// A page token can read fine (followers, insights, post metrics) long after it
// has lost the ability to PUBLISH — Meta reports that as an error on the post,
// not on the account, so nothing here used to notice. The page kept showing
// "Healthy" while every scheduled post to it failed with the same cryptic
// message, until someone manually disconnected and reconnected it.
//
// These helpers close that loop: a publish failure that is about the account
// (see requiresAccountAction) flips publishing_ok to false, records WHY in
// metadata.auth_error, and raises one notification. A later successful publish
// or a successful sync clears it again.

import { createServiceSupabase } from "./supabaseServer";
import { logActivity } from "./activity";
import { requiresAccountAction } from "./metaError";

// Called from every publish path's catch block. Best-effort: never throws into
// the caller, so health bookkeeping can't turn a failed post into a 500.
// Returns true when the failure was attributed to the account.
export async function noteAccountPublishFailure(account, message) {
  try {
    if (!account?.id || !requiresAccountAction(message)) return false;

    const supabase = createServiceSupabase();
    // Only announce the healthy → broken transition. A page with ten queued
    // posts fails ten times in one cron run; that's one problem, not ten.
    const firstFailure = account.publishing_ok !== false;

    await supabase
      .from("social_accounts")
      .update({
        publishing_ok: false,
        // metadata is a whole-column jsonb write — spread the existing keys so
        // connected_via / source survive.
        metadata: {
          ...(account.metadata || {}),
          auth_error: { message, at: new Date().toISOString() },
        },
      })
      .eq("id", account.id);

    if (firstFailure) {
      const via = account.metadata?.connected_via?.fb_user_name;
      await logActivity({
        type: "account.publish_blocked",
        title: `${account.display_name} can't publish — reconnect the page`,
        status: "error",
        meta: {
          accountId: account.id,
          platform: account.platform,
          connectedVia: via || null,
          reason: message,
        },
      });
    }
    return true;
  } catch (e) {
    console.error("[accountHealth] could not flag account:", e.message);
    return false;
  }
}

// Called after a successful publish. Cheap no-op unless the account was
// previously flagged, so this costs nothing on the happy path.
export async function clearAccountPublishFailure(account) {
  try {
    if (!account?.id) return;
    if (account.publishing_ok !== false && !account.metadata?.auth_error) return;

    const supabase = createServiceSupabase();
    const metadata = { ...(account.metadata || {}) };
    delete metadata.auth_error;

    await supabase
      .from("social_accounts")
      .update({ publishing_ok: true, metadata })
      .eq("id", account.id);
  } catch (e) {
    console.error("[accountHealth] could not clear account flag:", e.message);
  }
}
