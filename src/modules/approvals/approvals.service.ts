import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { publishFacebookPost, publishFacebookReel, publishFacebookStory, postFacebookComment } from "../../lib/facebook";
import { publishInstagramPost, postInstagramComment } from "../../lib/instagram";
import { publishThreadsPost, postThreadsReply } from "../../lib/threads";
import { publishXPost, postXReply } from "../../lib/x";
import { publishYouTubeVideo } from "../../lib/youtube";
import { logActivity } from "../../lib/activity";
import { postForPlatform, platformOptions, fbFormat } from "../../lib/postContent";
// @ts-ignore - plain JS fact-check gate (env-gated, fail-open, no-op without a key).
import { factCheckCaption, factCheckEnabled } from "../../lib/factcheck";

const INSTANT_WINDOW_MS = 10 * 60 * 1000;

const POST_WITH_TARGETS = "*, post_targets(*, social_accounts(id, display_name, platform, avatar_url))";

@Injectable()
export class ApprovalsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async list(postId?: string) {
    const supabase = this.supabaseService.createServiceClient();
    let q = supabase.from("approvals").select("*").order("created_at", { ascending: false });
    if (postId) q = q.eq("post_id", postId);
    const { data, error } = await q.limit(100);
    // Original returns 200 with an error field so the panel still renders.
    if (error) return { error: error.message, approvals: [] };
    return { approvals: data };
  }

  // action: submit | approve | reject
  async act(me: any, payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    if (!me) throw new UnauthorizedException("Not logged in.");

    const { postId, action, comment, override } = payload || {};
    const reviewer = me.display_name || "You";
    if (!postId || !action) throw new BadRequestException("postId and action required.");

    if (!["submit", "approve", "reject"].includes(action)) {
      throw new BadRequestException("Unknown action.");
    }

    // Approving/rejecting is restricted: admins act on anything; a Group Head
    // only on posts from their OWN division. Submitting has no restriction.
    if (action !== "submit" && me.role !== "admin") {
      if (!me.is_group_head) {
        throw new ForbiddenException("Only an admin or your division's Group Head can approve/reject posts.");
      }
      const { data: target } = await supabase
        .from("scheduled_posts")
        .select("created_by")
        .eq("id", postId)
        .eq("user_id", OWNER_ID)
        .maybeSingle();
      const creatorDivisionId = target?.created_by
        ? (await supabase.from("profiles").select("division_id").eq("id", target.created_by).maybeSingle()).data
            ?.division_id
        : null;
      if (!creatorDivisionId || creatorDivisionId !== me.division_id) {
        throw new ForbiddenException("You can only approve/reject posts from your own division.");
      }
    }

    await supabase.from("approvals").insert({
      post_id: postId,
      action,
      reviewer: reviewer || "You",
      comment: comment || null,
    });

    if (action !== "approve") {
      const next: any =
        action === "submit"
          ? { approval_status: "pending", status: "pending_review", auto_approve_at: await this.autoApproveAt(supabase) }
          : { approval_status: "rejected", status: "rejected", auto_approve_at: null };

      const { data: post, error } = await supabase
        .from("scheduled_posts")
        .update(next)
        .eq("id", postId)
        .eq("user_id", OWNER_ID)
        .select(POST_WITH_TARGETS)
        .single();
      if (error) throw new InternalServerErrorException(error.message);

      await logActivity({
        type: `approval.${action}`,
        title: `Post ${action} by ${reviewer || "You"}`,
        status: action === "reject" ? "warning" : "info",
        meta: { postId },
      });
      return { post };
    }

    // ── approve ──
    const { data: post, error: fetchError } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(*))")
      .eq("id", postId)
      .eq("user_id", OWNER_ID)
      .single();
    if (fetchError || !post) throw new NotFoundException(fetchError?.message || "Post not found.");

    // Fact-check gate (skipped on explicit override). On block/flag the post is
    // held in pending_review with the verdict attached so the reviewer can then
    // "Approve anyway" (override:true).
    let applied = post.fact_check || null;
    if (!override && factCheckEnabled()) {
      const fc = await factCheckCaption({ caption: post.body || "" });
      if (fc.action === "block" || fc.action === "flag") {
        const { data: held } = await supabase
          .from("scheduled_posts")
          .update({ fact_check: fc })
          .eq("id", postId)
          .eq("user_id", OWNER_ID)
          .select(POST_WITH_TARGETS)
          .single();
        await logActivity({
          type: "approval.factcheck",
          title: `Fact-check ${fc.action} — held for review`,
          status: "warning",
          meta: { postId, reason: fc.reason },
        });
        return { post: held, factCheck: fc, held: true };
      }
      applied = fc;
    }
    if (override && post.fact_check) {
      applied = { ...post.fact_check, overridden: true, overridden_by: reviewer, at: new Date().toISOString() };
    }

    return this.publishApprovedPost(supabase, post, reviewer, applied);
  }

  // Publishes/schedules every target of an approved post, then finalizes the
  // post row. Shared by manual approve and the auto-approve cron.
  private async publishApprovedPost(supabase: any, post: any, reviewer: string, factCheck: any) {
    const diffMs = new Date(post.scheduled_for).getTime() - Date.now();
    const publishNow = diffMs <= INSTANT_WINDOW_MS;
    const results: any[] = [];

    for (const target of post.post_targets || []) {
      const account: any = target.social_accounts;
      if (!account) {
        results.push({ status: "failed", error: "Page no longer connected." });
        continue;
      }

      try {
        // Per-platform caption override (falls back to the master body).
        const postData = postForPlatform(post, account.platform);
        let result,
          targetStatus,
          sentAt = null;

        // Only YouTube keeps native scheduling; everything else (incl. Facebook
        // feed posts) is published from OUR cron queue when the scheduled time
        // arrives (/api/cron/publish), which also posts the first comment. Meta's
        // native scheduler never lets us attach a first comment afterwards, so we
        // schedule FB ourselves too — like IG/Threads/X and FB Reels/Stories.
        if (account.platform !== "youtube" && !publishNow) {
          await supabase.from("post_targets").update({ status: "scheduled" }).eq("id", target.id);
          results.push({ accountId: account.id, name: account.display_name, status: "scheduled" });
          continue;
        }

        if (account.platform === "youtube") {
          // Uploads now; future posts use YouTube's native publishAt.
          result = await publishYouTubeVideo({ account, post: postData, scheduledFor: publishNow ? null : post.scheduled_for, options: platformOptions(post, "youtube") });
          targetStatus = publishNow ? "sent" : "scheduled";
          if (publishNow) sentAt = new Date().toISOString();
        } else if (account.platform === "instagram") {
          result = await publishInstagramPost({ account, post: postData });
          targetStatus = "sent";
          sentAt = new Date().toISOString();
        } else if (account.platform === "threads") {
          result = await publishThreadsPost({ account, post: postData });
          targetStatus = "sent";
          sentAt = new Date().toISOString();
        } else if (account.platform === "twitter") {
          result = await publishXPost({ account, post: postData });
          targetStatus = "sent";
          sentAt = new Date().toISOString();
        } else {
          // Facebook, publish now. Scheduled FB posts were queued above and are
          // published later by /api/cron/publish (which also posts the first
          // comment), so only the immediate case reaches here.
          const format = fbFormat(post);
          result = format === "reel"
            ? await publishFacebookReel({ account, post: postData })
            : format === "story"
              ? await publishFacebookStory({ account, post: postData })
              : await publishFacebookPost({ account, post: postData });
          targetStatus = "sent";
          sentAt = new Date().toISOString();
        }

        await supabase
          .from("post_targets")
          .update({ status: targetStatus, external_post_id: result.externalPostId, sent_at: sentAt })
          .eq("id", target.id);

        // Stories have no comments — skip the first comment for them.
        const isStory = account.platform === "facebook" && fbFormat(post) === "story";
        if (targetStatus === "sent" && !isStory && post.first_comment?.trim() && result.externalPostId) {
          try {
            if (account.platform === "instagram") {
              await postInstagramComment({ account, mediaId: result.externalPostId, message: post.first_comment });
            } else if (account.platform === "threads") {
              await postThreadsReply({ account, mediaId: result.externalPostId, message: post.first_comment });
            } else if (account.platform === "twitter") {
              await postXReply({ account, tweetId: result.externalPostId, message: post.first_comment });
            } else if (account.platform !== "youtube") {
              await postFacebookComment({ account, postId: result.externalPostId, message: post.first_comment });
            }
          } catch (commentError) {
            console.warn(`[approvals] first comment failed for ${account.display_name}:`, commentError.message);
          }
        }

        results.push({ accountId: account.id, name: account.display_name, status: targetStatus });
      } catch (err) {
        await supabase.from("post_targets").update({ status: "failed", last_error: err.message }).eq("id", target.id);
        results.push({ accountId: account.id, name: account.display_name, status: "failed", error: err.message });
      }
    }

    const allFailed = results.length > 0 && results.every((r) => r.status === "failed");
    const anyFailed = results.some((r) => r.status === "failed");
    const allSent = publishNow && results.every((r) => r.status === "sent");
    const finalStatus = allFailed ? "failed" : publishNow ? "sent" : "scheduled";

    const { data: updated, error: updateError } = await supabase
      .from("scheduled_posts")
      .update({
        status: finalStatus,
        approval_status: "approved",
        auto_approve_at: null,
        fact_check: factCheck,
        sent_at: allSent ? new Date().toISOString() : null,
      })
      .eq("id", post.id)
      .eq("user_id", OWNER_ID)
      .select(POST_WITH_TARGETS)
      .single();
    if (updateError) throw new InternalServerErrorException(updateError.message);

    await logActivity({
      type: allFailed ? "post.failed" : "approval.approve",
      title: allFailed
        ? "Approved post failed on all pages"
        : `Approved and published to ${results.filter((r) => r.status !== "failed").length} page(s) by ${reviewer}`,
      status: allFailed ? "error" : anyFailed ? "warning" : "success",
      meta: { postId: post.id, results: results.map((r) => ({ name: r.name, status: r.status })) },
    });

    return { post: updated, warning: anyFailed && !allFailed ? "Some pages failed." : null };
  }

  // Resolves the auto-approve deadline for a freshly-submitted post from the
  // shared app setting, or null when auto-approve is off.
  private async autoApproveAt(supabase: any): Promise<string | null> {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("user_id", OWNER_ID)
      .eq("key", "app")
      .maybeSingle();
    const cfg = data?.value || {};
    if (!cfg.autoApprove) return null;
    const hours = Number(cfg.autoApproveHours) > 0 ? Number(cfg.autoApproveHours) : 24;
    return new Date(Date.now() + hours * 3600000).toISOString();
  }

  // Cron entry point: approve every pending_review post whose auto_approve_at
  // has passed (unless the fact-check gate blocks/flags it).
  async autoApproveDue() {
    const supabase = this.supabaseService.createServiceClient();
    const nowIso = new Date().toISOString();

    const { data: due, error } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(*))")
      .eq("user_id", OWNER_ID)
      .eq("status", "pending_review")
      .not("auto_approve_at", "is", null)
      .lte("auto_approve_at", nowIso)
      .limit(25);
    if (error) throw new InternalServerErrorException(error.message);

    let approved = 0,
      held = 0,
      failed = 0;

    for (const post of due || []) {
      // A baked-in block never auto-waves through.
      if (post.fact_check?.action === "block") {
        held++;
        continue;
      }
      try {
        let applied = post.fact_check || null;
        if (factCheckEnabled() && !post.fact_check?.checked) {
          const fc = await factCheckCaption({ caption: post.body || "" });
          if (fc.action === "block" || fc.action === "flag") {
            await supabase.from("scheduled_posts").update({ fact_check: fc }).eq("id", post.id);
            held++;
            continue;
          }
          applied = fc;
        }
        await this.publishApprovedPost(supabase, post, "Auto-approve", applied);
        approved++;
      } catch (e) {
        failed++;
        console.warn(`[auto-approve] failed for post ${post.id}:`, e.message);
      }
    }

    return { due: (due || []).length, approved, held, failed };
  }
}
