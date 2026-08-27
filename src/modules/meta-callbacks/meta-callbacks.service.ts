import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { parseSignedRequest } from "../../lib/metaSignedRequest";
import { logActivity } from "../../lib/activity";

// The two Meta-initiated callbacks every Meta app has to name in its dashboard:
//
//   Deauthorize callback URL   — Meta POSTs here when a user removes the app
//                                from their Facebook/Instagram account.
//   Data deletion request URL  — Meta POSTs here when a user asks, through
//                                Facebook/Instagram, for their data to be
//                                deleted. MUST answer with JSON
//                                { url, confirmation_code }.
//
// A note on why the data-deletion one can't just point at /data-deletion:
// Meta accepts EITHER a *Data Deletion Instructions URL* (a human-readable
// page — which is what our /data-deletion page is, and what the Facebook app
// settings use) OR a *Data Deletion Request URL* (this programmatic callback).
// The Instagram "Business login settings" screen asks specifically for the
// callback, and a static HTML page there does not satisfy the contract: Meta
// expects a JSON body back and treats anything else as a failed request.
//
// Both callbacks identify the user by the app-scoped `user_id` inside the
// signed request. For a direct Instagram-Login row that value IS our
// `external_account_id`, so the mapping is exact. For Facebook-Login rows it is
// the app-scoped FB *user* id, which we store on each row as
// `metadata.connected_via.fb_user_id` — the grantor tag that already exists so
// pages from several Facebook accounts can be disconnected independently.
@Injectable()
export class MetaCallbacksService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // Deauthorization: the token we hold is already dead, so the honest response
  // is to drop it and flag the account rather than keep pretending it works.
  //
  // Deliberately NOT deleting the row: deauthorizing is not the same as asking
  // for deletion (that is the other callback), and silently vanishing an
  // account — along with its category, queue slots and post history — would
  // destroy work the user never asked us to discard. Clearing the token and
  // marking it unable to publish is recoverable by reconnecting; a delete is
  // not.
  async deauthorize(signedRequest: string) {
    const parsed = parseSignedRequest(signedRequest);
    if (!parsed.ok) {
      console.warn("[meta-callbacks] deauthorize rejected:", parsed.error);
      // Still 200 — Meta retries on failure, and we do not want a retry storm
      // over a request we will never accept. The log is the record.
      return { ok: false, error: parsed.error };
    }

    const userId = String(parsed.payload.user_id || "");
    if (!userId) return { ok: false, error: "signed_request carried no user_id." };

    const affected = await this.findAccountsFor(userId);
    if (!affected.length) {
      console.log(`[meta-callbacks] deauthorize for ${userId} (${parsed.signedBy}) matched no accounts.`);
      return { ok: true, matched: 0 };
    }

    const supabase = this.supabaseService.createServiceClient();
    for (const a of affected) {
      await supabase
        .from("social_accounts")
        .update({
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
          publishing_ok: false,
          metadata: {
            ...(a.metadata || {}),
            auth_error: {
              message:
                "Access was removed from the Meta side (app deauthorized). Reconnect this account to resume publishing.",
              at: new Date().toISOString(),
            },
          },
        })
        .eq("id", a.id);
    }

    await logActivity({
      type: "account.disconnected",
      title: `Meta deauthorized ${affected.length} account${affected.length === 1 ? "" : "s"}`,
      status: "warning",
      meta: {
        signed_by: parsed.signedBy,
        meta_user_id: userId,
        names: affected.map((a: any) => a.display_name),
      },
    });

    return { ok: true, matched: affected.length };
  }

  // Data deletion. Meta requires a JSON body of { url, confirmation_code }
  // where the url is a page a human can visit to see the status of the request.
  //
  // We delete synchronously — it is a small Postgres delete, not a job — so the
  // status is always "already done" by the time the user follows the link. The
  // confirmation code is recorded in activity_log, which makes the request
  // auditable without inventing a new table for one row per rare event.
  async dataDeletion(signedRequest: string, publicBase: string) {
    const parsed = parseSignedRequest(signedRequest);
    const code = this.confirmationCode();

    if (!parsed.ok) {
      console.warn("[meta-callbacks] data deletion rejected:", parsed.error);
      // Meta still expects the documented JSON shape even when we could not act,
      // so answer it — the status page explains an unverified request.
      await logActivity({
        type: "account.disconnected",
        title: "Meta data-deletion request could not be verified",
        status: "warning",
        meta: { confirmation_code: code, error: parsed.error },
      });
      return { url: this.statusUrl(publicBase, code), confirmation_code: code };
    }

    const userId = String(parsed.payload.user_id || "");
    const affected = userId ? await this.findAccountsFor(userId) : [];

    if (affected.length) {
      const supabase = this.supabaseService.createServiceClient();
      // Delete the rows outright. Unlike deauthorization this IS an explicit
      // request to erase, so the tokens, ids, display names and avatars go.
      // post_targets/post_insights referencing them cascade or orphan by
      // schema; published posts on the platform are untouched and are the
      // platform's to remove, which /data-deletion says in as many words.
      await supabase
        .from("social_accounts")
        .delete()
        .in(
          "id",
          affected.map((a: any) => a.id),
        );
    }

    await logActivity({
      type: "account.disconnected",
      title: affected.length
        ? `Meta data-deletion request: removed ${affected.length} account${affected.length === 1 ? "" : "s"}`
        : "Meta data-deletion request: nothing stored for this user",
      status: affected.length ? "warning" : "info",
      meta: {
        confirmation_code: code,
        signed_by: parsed.signedBy,
        meta_user_id: userId,
        names: affected.map((a: any) => a.display_name),
      },
    });

    return { url: this.statusUrl(publicBase, code), confirmation_code: code };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  // Every row this Meta user id can speak for:
  //   - direct Instagram-Login rows, where the id IS external_account_id
  //   - Facebook-Login rows tagged with the granting FB user
  // Postiz rows are excluded: Postiz holds that authorization, so a Meta
  // deauthorization says nothing about them and acting would be wrong.
  private async findAccountsFor(metaUserId: string) {
    const supabase = this.supabaseService.createServiceClient();
    const { data, error } = await supabase
      .from("social_accounts")
      .select("id, display_name, platform, publish_via, external_account_id, metadata")
      .eq("user_id", OWNER_ID);
    if (error) {
      console.error("[meta-callbacks] account lookup failed:", error.message);
      return [];
    }

    return (data || []).filter((a: any) => {
      if (a.publish_via === "postiz") return false;
      const isDirectIg =
        a.metadata?.instagram?.login === "instagram" && String(a.external_account_id) === metaUserId;
      const grantedBy = String(a.metadata?.connected_via?.fb_user_id || "") === metaUserId;
      return isDirectIg || grantedBy;
    });
  }

  // Short, unambiguous, and safe to read aloud over support. Not a secret —
  // it identifies a request, it does not authorize anything.
  private confirmationCode() {
    return `esp-${createHash("sha256").update(randomBytes(16)).digest("hex").slice(0, 16)}`;
  }

  private statusUrl(publicBase: string, code: string) {
    return `${publicBase.replace(/\/$/, "")}/data-deletion?code=${encodeURIComponent(code)}`;
  }
}
