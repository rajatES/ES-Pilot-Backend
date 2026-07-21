import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";

@Injectable()
export class NotificationsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async list() {
    const supabase = this.supabaseService.createServiceClient();
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("created_at", { ascending: false })
      .limit(50);
    // Original returns 200 with an error field (not a 500) so the bell can render.
    if (error) return { error: error.message, notifications: [] };
    const unread = (data || []).filter((n) => !n.read).length;
    return { notifications: data || [], unread };
  }

  // Mark all read (or a subset via {ids}).
  async markRead(ids?: any[]) {
    const supabase = this.supabaseService.createServiceClient();
    let q = supabase.from("notifications").update({ read: true }).eq("user_id", OWNER_ID);
    if (Array.isArray(ids) && ids.length) q = q.in("id", ids);
    else q = q.eq("read", false);
    const { error } = await q;
    if (error) throw new InternalServerErrorException(error.message);
    return { ok: true };
  }
}
