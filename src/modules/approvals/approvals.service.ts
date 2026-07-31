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
// @ts-ignore - shared auto-approve deadline helper (also used by posts.create).
import { computeAutoApproveAt } from "../../lib/approvalSettings";

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

  // Pending-approval queue as a flat list of (post × page) items — the UI groups
  // them by page. Each item carries whether the current viewer may review it
  // (admin, or the Group Head of the post author's division), so the client can
  // show/hide actions without duplicating the rule.
  async pending(me: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { data: posts } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(id, display_name, platform, avatar_url, category, external_account_id))")
      .eq("user_id", OWNER_ID)
      .eq("status", "pending_review")
      .order("created_at", { ascending: true });

    const authorIds = [...new Set((posts || []).map((p: any) => p.created_by).filter(Boolean))];
    const authorsById: Record<string, any> = {};
    if (authorIds.length) {
      const { data: profs } = await supabase.from("profiles").select("id, display_name, division_id").in("id", authorIds);
      for (const a of profs || []) authorsById[a.id] = a;
    }

    const mediaType = (p: any) => {
      const media = Array.isArray(p.media) ? p.media : [];
      if (media.some((m: any) => m?.type === "video")) return "video";
      if (media.some((m: any) => m?.type === "image") || p.image_url) return "photo";
      if (p.link_url) return "link";
      return "text";
    };

    const items: any[] = [];
    for (const p of posts || []) {
      const author = authorsById[p.created_by] || null;
      const canReview =
        me?.role === "admin" ||
        (me?.is_group_head && author?.division_id && author.division_id === me?.division_id);
      for (const t of p.post_targets || []) {
        if (t.status !== "pending_review") continue; // only pages still awaiting review
        const acct = t.social_accounts || {};
        items.push({
          postId: p.id,
          targetId: t.id,
          accountId: t.social_account_id,
          externalAccountId: acct.external_account_id || null,
          platform: t.platform,
          page: acct.display_name || "Page",
          avatarUrl: acct.avatar_url || null,
          category: acct.category || null,
          title: p.body || "",
          thumbnailUrl: p.image_url || null,
          linkUrl: p.link_url || null,
          mediaType: mediaType(p),
          format: p.platform_options?.[t.platform]?.format || null,
          scheduledFor: p.scheduled_for,
          autoApproveAt: p.auto_approve_at,
          createdBy: p.created_by,
          authorName: author?.display_name || null,
          source: p.source || "app",
          apiKeyId: p.api_key_id || null,
          factCheck: p.fact_check || null,
          submittedAt: p.created_at,
          canReview: !!canReview,
        });
      }
    }
    return { items };
  }

  // action: submit | approve | reject.
  // For approve/reject, an optional `accountId` scopes the action to a SINGLE
  // page (post_target); omit it to act on every still-pending page of the post.
  async act(me: any, payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    if (!me) throw new UnauthorizedException("Not logged in.");

    const { postId, accountId, action, comment, override } = payload || {};
    const reviewer = me.display_name || "You";
    if (!postId || !action) throw new BadRequestException("postId and action required.");

    if (!["submit", "approve", "reject"].includes(action)) {
      throw new BadRequestException("Unknown action.");
    }

    // Approving/rejecting is restricted: admins act on anything; a Group Head
    // only on posts from their OWN division. Submitting has no restriction.
    // (Page grouping is a navigation aid — permission stays author-division-based.)
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
      approver_id: me.id || null,
      social_account_id: accountId || null,
      comment: comment || null,
    });

    // ── submit / resubmit ── (whole post; resets reviewable pages to pending)
    if (action === "submit") {
      const { data: existing } = await supabase.from("post_targets").select("id, status").eq("post_id", postId);
      for (const t of existing || []) {
        if (t.status !== "sent" && t.status !== "scheduled" && t.status !== "publishing") {
          await supabase
            .from("post_targets")
            .update({ status: "pending_review", reviewed_by: null, reviewed_at: null })
            .eq("id", t.id);
        }
      }
      const { data: post, error } = await supabase
        .from("scheduled_posts")
        .update({ approval_status: "pending", status: "pending_review", auto_approve_at: await computeAutoApproveAt(supabase, OWNER_ID) })
        .eq("id", postId)
        .eq("user_id", OWNER_ID)
        .select(POST_WITH_TARGETS)
        .single();
      if (error) throw new InternalServerErrorException(error.message);
      await logActivity({ type: "approval.submit", title: `Post submitted for review by ${reviewer}`, status: "info", meta: { postId } });
      return { post };
    }

    // ── approve / reject ── load post + its targets
    const { data: post, error: fetchError } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(*))")
      .eq("id", postId)
      .eq("user_id", OWNER_ID)
      .single();
    if (fetchError || !post) throw new NotFoundException(fetchError?.message || "Post not found.");

    // Which pages this action applies to: the single requested page, or all
    // still-pending pages when no accountId is given.
    let targets = (post.post_targets || []).filter((t: any) => t.status === "pending_review");
    if (accountId) targets = targets.filter((t: any) => t.social_account_id === accountId);
    if (!targets.length) {
      const { data: fresh } = await supabase.from("scheduled_posts").select(POST_WITH_TARGETS).eq("id", postId).single();
      return { post: fresh, warning: "No pending pages for this action." };
    }

    if (action === "reject") {
      const now = new Date().toISOString();
      for (const t of targets) {
        await supabase
          .from("post_targets")
          .update({ status: "rejected", reviewed_by: me.id || null, reviewed_at: now })
          .eq("id", t.id);
      }
      const updated = await this.recomputePostStatus(supabase, postId);
      await logActivity({
        type: "approval.reject",
        title: `Rejected ${targets.length} page(s) by ${reviewer}`,
        status: "warning",
        meta: { postId, accountId: accountId || null },
      });
      return { post: updated };
    }

    // ── approve ── Fact-check gate (post-level; the caption is shared). On
    // block/flag the post is held with the verdict attached so the reviewer can
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

    return this.publishTargets(supabase, post, targets, reviewer, applied, me.id || null);
  }

  // Publishes/schedules a GIVEN set of the post's targets (one page for a
  // per-page approval, or all pending pages for a whole-post/auto approve),
  // stamps each with the approver, then rolls the post status up from ALL its
  // targets. Shared by manual approve and the auto-approve cron.
  private async publishTargets(supabase: any, post: any, targets: any[], reviewer: string, factCheck: any, approverId: string | null) {
    const diffMs = new Date(post.scheduled_for).getTime() - Date.now();
    const publishNow = diffMs <= INSTANT_WINDOW_MS;
    const results: any[] = [];
    const review = () => ({ reviewed_by: approverId, reviewed_at: new Date().toISOString() });

    for (const target of targets || []) {
      const account: any = target.social_accounts;
      if (!account) {
        await supabase.from("post_targets").update({ status: "failed", last_error: "Page no longer connected.", ...review() }).eq("id", target.id);
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
          await supabase.from("post_targets").update({ status: "scheduled", ...review() }).eq("id", target.id);
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
          .update({ status: targetStatus, external_post_id: result.externalPostId, sent_at: sentAt, ...review() })
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
        await supabase.from("post_targets").update({ status: "failed", last_error: err.message, ...review() }).eq("id", target.id);
        results.push({ accountId: account.id, name: account.display_name, status: "failed", error: err.message });
      }
    }

    // Attach the fact-check verdict, then roll the post status up from ALL its
    // targets (this batch may be just one page of several).
    await supabase.from("scheduled_posts").update({ fact_check: factCheck }).eq("id", post.id).eq("user_id", OWNER_ID);
    const updated = await this.recomputePostStatus(supabase, post.id);

    const anyFailed = results.some((r) => r.status === "failed");
    const allFailed = results.length > 0 && results.every((r) => r.status === "failed");
    const okCount = results.filter((r) => r.status !== "failed").length;
    await logActivity({
      type: allFailed ? "post.failed" : "approval.approve",
      title: allFailed
        ? "Approved page(s) failed to publish"
        : `Approved ${okCount} page(s) by ${reviewer}`,
      status: allFailed ? "error" : anyFailed ? "warning" : "success",
      meta: { postId: post.id, results: results.map((r) => ({ name: r.name, status: r.status })) },
    });

    return { post: updated, warning: anyFailed && !allFailed ? "Some pages failed." : null };
  }

  // Rolls a post's status/approval_status up from its per-page targets:
  //  - any page still pending_review  → post stays pending_review
  //  - otherwise → approved if any page was published/scheduled (even if some
  //    failed), else rejected (all pages rejected). status mirrors the pages.
  private async recomputePostStatus(supabase: any, postId: string) {
    const { data: targets } = await supabase.from("post_targets").select("status").eq("post_id", postId);
    const list = targets || [];
    const pending = list.filter((t: any) => t.status === "pending_review");
    let update: any;
    if (pending.length) {
      update = { approval_status: "pending", status: "pending_review" };
    } else {
      const attempted = list.filter((t: any) => ["sent", "scheduled", "publishing", "failed"].includes(t.status));
      const published = list.filter((t: any) => ["sent", "scheduled", "publishing"].includes(t.status));
      let status: string;
      if (!attempted.length) status = "rejected"; // every page rejected
      else if (!published.length) status = "failed"; // all attempts failed
      else if (list.some((t: any) => t.status === "sent")) status = "sent";
      else status = "scheduled";
      update = {
        approval_status: attempted.length ? "approved" : "rejected",
        status,
        auto_approve_at: null,
        sent_at: status === "sent" ? new Date().toISOString() : null,
      };
    }
    const { data: post, error } = await supabase
      .from("scheduled_posts")
      .update(update)
      .eq("id", postId)
      .eq("user_id", OWNER_ID)
      .select(POST_WITH_TARGETS)
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return post;
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
        const pending = (post.post_targets || []).filter((t: any) => t.status === "pending_review");
        await this.publishTargets(supabase, post, pending, "Auto-approve", applied, null);
        approved++;
      } catch (e) {
        failed++;
        console.warn(`[auto-approve] failed for post ${post.id}:`, e.message);
      }
    }

    return { due: (due || []).length, approved, held, failed };
  }
}
