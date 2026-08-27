import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { logActivity } from "../../lib/activity";
import { metaErrorMessage } from "../../lib/metaError";
import { instagramGraphBase } from "../../lib/instagram";

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
  //
  // This is a PUBLISH-capability check, not just a read. A page token keeps
  // answering read queries (followers, insights) long after it has lost the
  // right to post, so the old followers-only probe reported "Healthy" for
  // pages whose every scheduled post was failing. For Facebook we now also ask
  // for `tasks` — the permissions the token actually holds on that page — and
  // treat a missing CREATE_CONTENT as unhealthy.
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
        // Postiz-backed channels hold no token of ours, and a Postiz-backed
        // Instagram row still has platform "instagram" — so without this it
        // would fall into the Graph probe below with access_token=null, fail,
        // and get stamped "can't publish" on every sync. Postiz owns their
        // token health; leave it alone. (Checked before platform for exactly
        // that reason.)
        if (a.publish_via === "postiz") {
          results.push({ id: a.id, ok: true, skipped: true });
          continue;
        }
        if (a.platform === "instagram") {
          // Which Graph host serves this account depends on HOW it was
          // connected: a direct Instagram-Login row lives on
          // graph.instagram.com and 400s on graph.facebook.com. Probing the
          // wrong host would fail and stamp `publishing_ok: false` on every
          // sync — falsely marking a healthy account broken, the same trap
          // Postiz rows fell into above. instagramGraphBase() is the single
          // place that decision is made.
          const r = await fetch(
            `${instagramGraphBase(a)}/${a.external_account_id}?fields=followers_count,media_count,username&access_token=${a.access_token}`,
          );
          const dd = await r.json();
          if (!r.ok) throw new Error(metaErrorMessage(dd, "Sync failed"));
          followers = dd.followers_count ?? null;
        } else if (a.platform === "facebook") {
          const r = await fetch(
            `${GRAPH}/${a.external_account_id}?fields=followers_count,fan_count,name,tasks&access_token=${a.access_token}`,
          );
          const dd = await r.json();
          if (!r.ok) throw new Error(metaErrorMessage(dd, "Sync failed"));
          followers = dd.followers_count ?? null;
          likes = dd.fan_count ?? null;
          // Only judge when Graph actually returned the field — treating an
          // absent `tasks` as "can't publish" would flag healthy pages.
          if (Array.isArray(dd.tasks) && !dd.tasks.includes("CREATE_CONTENT")) {
            throw new Error(
              "This token can no longer create content on the Page (missing CREATE_CONTENT). Reconnect the Page to restore publishing.",
            );
          }
        } else {
          // Non-Meta platforms (YouTube/X/Threads) have their own token flows —
          // leave their health untouched rather than guessing from a Graph call.
          results.push({ id: a.id, ok: true, skipped: true });
          continue;
        }

        const metadata = { ...(a.metadata || {}) };
        delete metadata.auth_error;
        await supabase
          .from("social_accounts")
          .update({
            followers,
            page_likes: likes,
            last_synced_at: new Date().toISOString(),
            publishing_ok: true,
            metadata,
          })
          .eq("id", a.id);
        results.push({ id: a.id, ok: true });
      } catch (e) {
        await supabase
          .from("social_accounts")
          .update({
            publishing_ok: false,
            last_synced_at: new Date().toISOString(),
            metadata: {
              ...(a.metadata || {}),
              auth_error: { message: e.message, at: new Date().toISOString() },
            },
          })
          .eq("id", a.id);
        results.push({ id: a.id, ok: false, error: e.message });
      }
    }

    const broken = results.filter((r) => !r.ok);
    await logActivity({
      type: "account.synced",
      title: broken.length
        ? `Synced ${results.length} account(s) — ${broken.length} need reconnecting`
        : `Synced ${results.length} account(s)`,
      status: broken.length ? "warning" : "info",
      meta: broken.length ? { broken: broken.map((b) => ({ id: b.id, error: b.error })) } : {},
    });

    const { data: updated } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("created_at", { ascending: false });
    return { results, accounts: updated };
  }
}
