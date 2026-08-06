import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import {
  exchangeForLongLivedToken,
  fetchPermanentPageTokens,
  fetchLinkedInstagramAccounts,
  fetchTokenOwner,
} from "../../lib/facebookOAuth";
import { detectSport } from "../../lib/sports";
import { logActivity } from "../../lib/activity";

@Injectable()
export class SocialService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // Step 1 of the JS-SDK flow: exchange the short-lived token and list Pages.
  async fetchPages(payload: any) {
    const { shortLivedToken } = payload || {};
    if (!shortLivedToken) {
      throw new BadRequestException("Missing Facebook access token.");
    }

    try {
      const longLivedToken = await exchangeForLongLivedToken(shortLivedToken);

      const grantor = await fetchTokenOwner(longLivedToken);
      console.log(`[Meta] fetch-pages: token belongs to ${grantor.fb_user_name} (${grantor.fb_user_id}).`);

      const pages = await fetchPermanentPageTokens(longLivedToken);
      console.log(`[Meta] fetch-pages: ${pages.length} page(s) found.`);

      if (!pages.length) {
        // Original returns 200 with an error field so the UI can explain.
        return {
          error: "No Pages found. Make sure you granted access to at least one Page in the popup.",
          pages: [],
          grantor,
        };
      }

      const safePages = pages.map((p: any) => ({
        id: p.id,
        name: p.name,
        access_token: p.access_token,
        picture: p.picture?.data?.url || null,
        platform: "facebook",
      }));

      const igAccounts = await fetchLinkedInstagramAccounts(pages);
      console.log(`[Meta] fetch-pages: ${igAccounts.length} linked Instagram account(s).`);

      const combined = [
        ...safePages,
        ...igAccounts.map((ig: any) => ({
          id: ig.id,
          name: ig.name,
          access_token: ig.access_token,
          picture: ig.picture,
          platform: "instagram",
        })),
      ];

      return { pages: combined, grantor };
    } catch (err) {
      console.error("[Meta] fetch-pages error:", err.message);
      throw new InternalServerErrorException(err.message || "Failed to fetch Facebook Pages.");
    }
  }

  // Step 2 of the JS-SDK flow: save the selected Pages.
  async confirmPages(payload: any) {
    const supabase = this.supabaseService.createServiceClient();

    const { pages, grantor } = payload || {};
    if (!Array.isArray(pages) || !pages.length) {
      throw new BadRequestException("No Pages selected.");
    }

    // Page tokens minted from a LONG-LIVED user token do not expire on a clock —
    // they die when access is revoked (password change, checkpoint, lost Page
    // role, app-role removal in dev mode). The old code stamped a fabricated
    // "now + 60 days" here, which made the Accounts health badge report a
    // countdown that meant nothing and hid tokens that had already died. Leave
    // it null and let the real publish-capability probe in accounts.sync()
    // (plus publish-time failures) decide whether a page is healthy.
    const expiresAt = null;

    const connectedVia = grantor?.fb_user_id
      ? {
          fb_user_id: grantor.fb_user_id,
          fb_user_name: grantor.fb_user_name || "Facebook account",
          avatar: grantor.avatar || null,
          connected_at: new Date().toISOString(),
        }
      : null;

    const rows = pages.map((page: any) => {
      const platform = page.platform === "instagram" ? "instagram" : "facebook";
      return {
        user_id: OWNER_ID,
        platform,
        account_type: platform === "instagram" ? "business" : "page",
        external_account_id: page.id,
        display_name: page.name,
        // FB page pictures from the API are expiring scontent URLs; store the
        // stable, non-expiring picture endpoint instead. IG has no such stable
        // public URL, so keep what the API gave (the UI falls back gracefully).
        avatar_url:
          platform === "facebook"
            ? `https://graph.facebook.com/${page.id}/picture?type=square`
            : page.picture || null,
        access_token: page.access_token,
        token_expires_at: expiresAt,
        category: detectSport(page.name),
        metadata: { source: "facebook_js_sdk", platform, ...(connectedVia ? { connected_via: connectedVia } : {}) },
      };
    });

    const { error: upsertError } = await supabase
      .from("social_accounts")
      .upsert(rows, { onConflict: "user_id,platform,external_account_id" });

    if (upsertError) {
      console.error("[Meta] confirm-pages save error:", upsertError.message);
      throw new InternalServerErrorException(upsertError.message);
    }

    await logActivity({
      type: "account.connected",
      title: `Connected ${rows.length} account${rows.length === 1 ? "" : "s"}`,
      status: "success",
      meta: { names: rows.map((r) => r.display_name) },
    });

    const { data: accounts } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("created_at", { ascending: false });

    return { success: true, connected: rows.length, accounts };
  }
}
