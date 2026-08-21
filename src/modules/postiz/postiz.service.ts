import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { detectSport } from "../../lib/sports";
import { logActivity } from "../../lib/activity";
import {
  POSTIZ_PROVIDERS,
  listPostizIntegrations,
  postizConfigured,
  postizPing,
} from "../../lib/postiz";

// Channel import for the platforms Postiz publishes on our behalf — Threads and
// personal/standalone Instagram (see lib/postiz.js for why those two).
//
// Postiz owns the OAuth, so there is no connect flow to run here: the user
// authorizes the channel once inside Postiz, and this module copies the
// resulting "integration" into a social_accounts row with publish_via="postiz".
// From then on it behaves like any other account — same composer, same queue,
// same approvals.
@Injectable()
export class PostizService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // Importing a brand channel is the same class of action as connecting a
  // Facebook Page, which is admin/Group-Head only — so gate it the same way.
  // Unlike the Meta connect routes (whose gate lives only in the UI, HANDOFF
  // §5) this is enforced here, because a new route has no callers to break.
  private assertCanManage(me: any) {
    if (me?.role !== "admin" && !me?.is_group_head) {
      throw new ForbiddenException("Only admins and Group Heads can import Postiz channels.");
    }
  }

  private assertConfigured() {
    if (!postizConfigured()) {
      throw new BadRequestException(
        "Postiz is not configured — set POSTIZ_API_KEY in the backend environment and restart.",
      );
    }
  }

  // Map a lib/postiz.js error onto an honest status code. A missing key or a
  // rejected key is OUR misconfiguration (4xx) — reporting it as a 500 sends
  // the reader looking for a server fault that isn't there. Only a genuine
  // upstream failure (Postiz 5xx, timeout, unreachable) is a 502.
  private upstream(e: any): never {
    const msg = e?.message || "Postiz request failed.";
    if (/not configured|\(401\)|\(403\)|\(429\)/.test(msg)) throw new BadRequestException(msg);
    throw new BadGatewayException(msg);
  }

  // GET /api/postiz/status — lets the UI say WHY the channel list is empty:
  // no key configured, key rejected, or simply nothing connected in Postiz.
  async status(me: any) {
    this.assertCanManage(me);
    if (!postizConfigured()) {
      return {
        configured: false,
        connected: false,
        error: "POSTIZ_API_KEY is not set on the backend.",
      };
    }
    try {
      const { connected } = await postizPing();
      return { configured: true, connected, error: null };
    } catch (e: any) {
      return { configured: true, connected: false, error: e.message };
    }
  }

  // GET /api/postiz/integrations — Postiz channels we can drive, each flagged
  // with whether it is already imported so the UI can show "Added" instead of
  // offering a duplicate.
  async integrations(me: any) {
    this.assertCanManage(me);
    this.assertConfigured();

    let channels: any[];
    try {
      channels = await listPostizIntegrations();
    } catch (e: any) {
      this.upstream(e);
    }

    const supabase = this.supabaseService.createServiceClient();
    const { data: existing } = await supabase
      .from("social_accounts")
      .select("id, external_account_id, publish_via")
      .eq("user_id", OWNER_ID);

    const importedIds = new Set(
      (existing || [])
        .filter((a: any) => a.publish_via === "postiz")
        .map((a: any) => String(a.external_account_id)),
    );

    return {
      integrations: channels.map((c) => ({ ...c, imported: importedIds.has(String(c.id)) })),
    };
  }

  // POST /api/postiz/import — save the picked channels as social_accounts rows.
  //
  // Every field the publish path needs comes from Postiz, not from the client:
  // the request only carries channel ids (plus an optional category), so a
  // caller can't invent a provider or point a row at someone else's channel.
  async importChannels(payload: any, me: any) {
    this.assertCanManage(me);
    this.assertConfigured();

    const requested = Array.isArray(payload?.channels) ? payload.channels : [];
    const ids = [
      ...new Set(
        requested
          .map((c: any) => (typeof c === "string" ? c : c?.id))
          .filter((id: any) => typeof id === "string" && id.trim()),
      ),
    ] as string[];
    if (!ids.length) throw new BadRequestException("No channels selected.");

    // Categories are the only caller-supplied field, keyed by channel id.
    const categories = new Map<string, string>();
    for (const c of requested) {
      if (c && typeof c === "object" && typeof c.category === "string" && c.category.trim()) {
        categories.set(String(c.id), c.category.trim());
      }
    }

    let available: any[];
    try {
      available = await listPostizIntegrations();
    } catch (e: any) {
      this.upstream(e);
    }

    const byId = new Map(available.map((c) => [String(c.id), c]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new BadRequestException(
        `${missing.length} selected channel(s) are no longer in the Postiz workspace (or are on an unsupported platform). Refresh and try again.`,
      );
    }

    const rows = ids.map((id) => {
      const channel = byId.get(id)!;
      return {
        user_id: OWNER_ID,
        // The REAL platform, not "postiz" — the composer, previews, validation
        // and analytics all key off this, and a Postiz-backed Threads channel
        // should look exactly like any other Threads account to them.
        platform: channel.platform,
        publish_via: "postiz",
        account_type: channel.platform === "instagram" ? "profile" : "profile",
        // The Postiz integration id: what /posts wants as integration.id.
        external_account_id: channel.id,
        display_name: channel.name,
        avatar_url: channel.picture || null,
        // Postiz holds the platform token; there is nothing for us to store,
        // and leaving these null keeps the native paths from ever trying.
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
        category: categories.get(id) || detectSport(channel.name),
        // Re-importing is the fix for a channel flagged as unable to publish,
        // so clear the flag (mirrors confirmPages for Facebook Pages).
        publishing_ok: true,
        metadata: {
          source: "postiz_import",
          platform: channel.platform,
          postiz: {
            // settings.__type at publish time — the distinction between
            // "instagram" and "instagram-standalone" lives ONLY here, since
            // both map to platform "instagram".
            provider: channel.provider,
            integration_id: channel.id,
            profile: channel.profile || null,
            customer: channel.customer || null,
            imported_at: new Date().toISOString(),
            imported_by: me?.id || null,
          },
        },
      };
    });

    const supabase = this.supabaseService.createServiceClient();
    const { error } = await supabase
      .from("social_accounts")
      .upsert(rows, { onConflict: "user_id,platform,external_account_id" });
    if (error) {
      console.error("[postiz] import save error:", error.message);
      throw new InternalServerErrorException(error.message);
    }

    await logActivity({
      type: "account.connected",
      title: `Imported ${rows.length} Postiz channel${rows.length === 1 ? "" : "s"}`,
      status: "success",
      meta: {
        names: rows.map((r) => r.display_name),
        providers: rows.map((r) => r.metadata.postiz.provider),
      },
    });

    const { data: accounts } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("created_at", { ascending: false });

    return { success: true, imported: rows.length, accounts };
  }

  // Providers this build knows how to drive — handy for the UI copy and for
  // spotting a Postiz workspace whose channels we all ignore.
  supportedProviders() {
    return { providers: Object.keys(POSTIZ_PROVIDERS) };
  }
}
