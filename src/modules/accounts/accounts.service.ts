import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { logActivity } from "../../lib/activity";

const GRAPH = "https://graph.facebook.com/v23.0";

@Injectable()
export class AccountsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // PATCH /api/accounts/:id — manual sport/category override.
  async updateCategory(id: string, category: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { error } = await supabase
      .from("social_accounts")
      .update({ category: category || null })
      .eq("id", id)
      .eq("user_id", OWNER_ID);
    if (error) throw new InternalServerErrorException(error.message);
    return { ok: true };
  }

  // DELETE /api/accounts/:id
  async remove(id: string) {
    const supabase = this.supabaseService.createServiceClient();
    const { error: deleteError } = await supabase
      .from("social_accounts")
      .delete()
      .eq("id", id)
      .eq("user_id", OWNER_ID);
    if (deleteError) throw new InternalServerErrorException(deleteError.message);
    return { ok: true };
  }

  // POST /api/accounts/bulk — category change or disconnect for many accounts.
  async bulk(payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { action, ids, value } = payload || {};

    if (!Array.isArray(ids) || !ids.length) {
      throw new BadRequestException("No accounts selected.");
    }

    if (action === "category") {
      const { error } = await supabase
        .from("social_accounts")
        .update({ category: value || null })
        .in("id", ids)
        .eq("user_id", OWNER_ID);
      if (error) throw new InternalServerErrorException(error.message);
      await logActivity({ type: "account.updated", title: `Set ${ids.length} account(s) to ${value}`, status: "info" });
    } else if (action === "disconnect") {
      const { error } = await supabase.from("social_accounts").delete().in("id", ids).eq("user_id", OWNER_ID);
      if (error) throw new InternalServerErrorException(error.message);
      await logActivity({
        type: "account.disconnected",
        title: `Disconnected ${ids.length} account(s)`,
        status: "warning",
      });
    } else {
      throw new BadRequestException("Unknown action.");
    }

    const { data: accounts } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("created_at", { ascending: false });
    return { ok: true, accounts };
  }

  // POST /api/accounts/disconnect — remove every Page connected via one FB account.
  async disconnect(me: any, fbUserId: any) {
    if (!me || (me.role !== "admin" && !me.is_group_head)) {
      throw new ForbiddenException("Only an admin or Group Head can disconnect accounts.");
    }
    if (!fbUserId) {
      throw new BadRequestException("Missing fbUserId.");
    }

    const supabase = this.supabaseService.createServiceClient();

    const { data: all, error: listError } = await supabase
      .from("social_accounts")
      .select("id, display_name, metadata")
      .eq("user_id", OWNER_ID);
    if (listError) throw new InternalServerErrorException(listError.message);

    const affected = (all || []).filter((a) => {
      const via = a.metadata?.connected_via;
      return fbUserId === "legacy" ? !via?.fb_user_id : via?.fb_user_id === fbUserId;
    });

    if (!affected.length) {
      throw new NotFoundException("No connected pages found for that account.");
    }

    const { error: deleteError } = await supabase
      .from("social_accounts")
      .delete()
      .in(
        "id",
        affected.map((a) => a.id),
      );
    if (deleteError) throw new InternalServerErrorException(deleteError.message);

    await logActivity({
      type: "account.disconnected",
      title: `Disconnected ${affected.length} page${affected.length === 1 ? "" : "s"} (source account removed)`,
      status: "warning",
      meta: { fbUserId, names: affected.map((a) => a.display_name) },
    });

    const { data: accounts } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("created_at", { ascending: false });

    return { ok: true, removed: affected.length, accounts: accounts || [] };
  }

  // POST /api/accounts/sync — refresh followers / likes / token health via Graph API.
  async sync(payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    const ids = Array.isArray(payload?.ids) ? payload.ids : null;

    let q = supabase.from("social_accounts").select("*").eq("user_id", OWNER_ID);
    if (ids?.length) q = q.in("id", ids);
    const { data: accounts, error } = await q;
    if (error) throw new InternalServerErrorException(error.message);

    const results: any[] = [];
    for (const a of accounts || []) {
      try {
        let followers = null,
          likes = null;
        if (a.platform === "instagram") {
          const r = await fetch(
            `${GRAPH}/${a.external_account_id}?fields=followers_count,media_count,username&access_token=${a.access_token}`,
          );
          const dd = await r.json();
          if (!r.ok) throw new Error(dd?.error?.message || "Sync failed");
          followers = dd.followers_count ?? null;
        } else {
          const r = await fetch(
            `${GRAPH}/${a.external_account_id}?fields=followers_count,fan_count,name&access_token=${a.access_token}`,
          );
          const dd = await r.json();
          if (!r.ok) throw new Error(dd?.error?.message || "Sync failed");
          followers = dd.followers_count ?? null;
          likes = dd.fan_count ?? null;
        }
        await supabase
          .from("social_accounts")
          .update({ followers, page_likes: likes, last_synced_at: new Date().toISOString(), publishing_ok: true })
          .eq("id", a.id);
        results.push({ id: a.id, ok: true });
      } catch (e) {
        await supabase
          .from("social_accounts")
          .update({ publishing_ok: false, last_synced_at: new Date().toISOString() })
          .eq("id", a.id);
        results.push({ id: a.id, ok: false, error: e.message });
      }
    }

    await logActivity({ type: "account.synced", title: `Synced ${results.length} account(s)`, status: "info" });

    const { data: updated } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("created_at", { ascending: false });
    return { results, accounts: updated };
  }
}
