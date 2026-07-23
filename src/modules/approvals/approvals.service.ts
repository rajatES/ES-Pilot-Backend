import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { scheduleFacebookPost, publishFacebookPost, publishFacebookReel, publishFacebookStory, postFacebookComment } from "../../lib/facebook";
import { publishInstagramPost, postInstagramComment } from "../../lib/instagram";
import { publishThreadsPost, postThreadsReply } from "../../lib/threads";
import { publishXPost, postXReply } from "../../lib/x";
import { publishYouTubeVideo } from "../../lib/youtube";
import { logActivity } from "../../lib/activity";
import { postForPlatform, platformOptions, fbFormat } from "../../lib/postContent";

const INSTANT_WINDOW_MS = 10 * 60 * 1000;

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

    const { postId, action, comment } = payload || {};
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
      const next =
        action === "submit"
          ? { approval_status: "pending", status: "pending_review" }
          : { approval_status: "rejected", status: "rejected" };

      const { data: post, error } = await supabase
        .from("scheduled_posts")
        .update(next)
        .eq("id", postId)
        .eq("user_id", OWNER_ID)
        .select("*, post_targets(*, social_accounts(id, display_name, platform, avatar_url))")
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

    // ── approve: actually publish/schedule now ──
    const { data: post, error: fetchError } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(*))")
      .eq("id", postId)
      .eq("user_id", OWNER_ID)
      .single();
    if (fetchError || !post) throw new NotFoundException(fetchError?.message || "Post not found.");

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
        let result, targetStatus, sentAt = null;

        // FB Reels/Stories are cron-queued like IG/Threads/X (no native scheduling).
        const fbNonFeed = account.platform === "facebook" && fbFormat(post) !== "post";
        if ((["instagram", "threads", "twitter"].includes(account.platform) || fbNonFeed) && !publishNow) {
          // No native scheduling on these platforms — leave the target queued;
          // /api/cron/publish sends it when the scheduled time arrives.
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
        } else if (publishNow) {
          const format = fbFormat(post);
          result = format === "reel"
            ? await publishFacebookReel({ account, post: postData })
            : format === "story"
              ? await publishFacebookStory({ account, post: postData })
              : await publishFacebookPost({ account, post: postData });
          targetStatus = "sent";
          sentAt = new Date().toISOString();
        } else {
          // Only format "post" reaches here — reels/stories were queued above.
          result = await scheduleFacebookPost({ account, post: postData, scheduledFor: post.scheduled_for });
          targetStatus = "scheduled";
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
      .update({ status: finalStatus, approval_status: "approved", sent_at: allSent ? new Date().toISOString() : null })
      .eq("id", postId)
      .eq("user_id", OWNER_ID)
      .select("*, post_targets(*, social_accounts(id, display_name, platform, avatar_url))")
      .single();
    if (updateError) throw new InternalServerErrorException(updateError.message);

    await logActivity({
      type: allFailed ? "post.failed" : "approval.approve",
      title: allFailed
        ? "Approved post failed on all pages"
        : `Approved and published to ${results.filter((r) => r.status !== "failed").length} page(s)`,
      status: allFailed ? "error" : anyFailed ? "warning" : "success",
      meta: { postId, results: results.map((r) => ({ name: r.name, status: r.status })) },
    });

    return { post: updated, warning: anyFailed && !allFailed ? "Some pages failed." : null };
  }
}
