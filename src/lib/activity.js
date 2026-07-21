import { createServiceSupabase, OWNER_ID } from "./supabaseServer";

// Records an event to activity_log. Best-effort — never throws into the caller,
// so logging can't break a publish/schedule/connect flow.
export async function logActivity({ type, title, status = "info", meta = {} }) {
  try {
    const supabase = createServiceSupabase();
    await supabase.from("activity_log").insert({
      user_id: OWNER_ID, type, title, status, meta
    });
    // Surface errors/warnings as notifications too.
    if (status === "error" || status === "warning") {
      await supabase.from("notifications").insert({
        user_id: OWNER_ID,
        type,
        title,
        severity: status,
        body: null
      });
    }
  } catch (e) {
    console.error("[activity] log failed:", e.message);
  }
}
