// Auto-approve deadline for a freshly-submitted review post, read from the
// shared app setting (Settings → auto-approve). Returns an ISO timestamp, or
// null when auto-approve is off. Shared by the approvals service AND
// posts.create (composer + Developer API) so every path that puts a post into
// review honors the same grace window — previously only the in-app "Submit for
// review" set it, so API-submitted posts never auto-approved.
export async function computeAutoApproveAt(supabase, ownerId) {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("user_id", ownerId)
    .eq("key", "app")
    .maybeSingle();
  const cfg = data?.value || {};
  if (!cfg.autoApprove) return null;
  const hours = Number(cfg.autoApproveHours) > 0 ? Number(cfg.autoApproveHours) : 24;
  return new Date(Date.now() + hours * 3600000).toISOString();
}
