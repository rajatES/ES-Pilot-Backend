import { createServiceSupabase, OWNER_ID } from "./supabaseServer";

// Appends UTM parameters to outbound links so clicks are attributable in
// Google Analytics (utm_campaign carries a short post id — one campaign per
// post). Existing utm_* params on the URL are respected and never overwritten.
export function appendUtm(url, { postId } = {}) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.searchParams.has("utm_source")) return url; // author already tagged it
    u.searchParams.set("utm_source", "es-scheduler");
    u.searchParams.set("utm_medium", "social");
    if (postId) u.searchParams.set("utm_campaign", `post-${String(postId).slice(0, 8)}`);
    return u.toString();
  } catch {
    return url; // not a parseable URL — leave it alone
  }
}

// Reads the workspace setting once per request. Defaults to OFF.
export async function utmTrackingEnabled() {
  const supabase = createServiceSupabase();
  const { data } = await supabase
    .from("app_settings").select("value").eq("user_id", OWNER_ID).eq("key", "app").maybeSingle();
  return !!data?.value?.utmTracking;
}
