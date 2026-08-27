import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { QueuesService } from "../queues/queues.service";
// Ported plain-JS integrations (allowJs). Types resolve to `any`.
import {
  publishFacebookPost,
  publishFacebookReel,
  publishFacebookStory,
  postFacebookComment,
  updateScheduledFacebookPost,
  checkFacebookPostStatus,
  publishUnpublishedFacebookPost,
} from "../../lib/facebook";
import { publishInstagramPost, postInstagramComment, checkInstagramPostStatus } from "../../lib/instagram";
import { publishPostizPost, reconcilePostizTarget } from "../../lib/postiz";
import { publishYouTubeVideo, checkYouTubeVideoStatus, updateScheduledYouTubeVideo } from "../../lib/youtube";
import { logActivity } from "../../lib/activity";
import { appendUtm, utmTrackingEnabled } from "../../lib/utm";
import { runCompliance } from "../../lib/compliance";
import {
  assertPublishable,
  postForPlatform,
  platformOptions,
  fbFormat,
  sanitizePlatformCaptions,
  sanitizePlatformOptions,
} from "../../lib/postContent";
import {
  CONTENT_TYPES_HINT,
  composeFirstComment,
  isValidContentType,
  linkInFirstCommentEnabled,
  normalizeContentType,
  normalizeTags,
  resolveFirstComment,
} from "../../lib/postFields";
// @ts-ignore - shared auto-approve deadline helper.
import { computeAutoApproveAt } from "../../lib/approvalSettings";
import { noteAccountPublishFailure, clearAccountPublishFailure } from "../../lib/accountHealth";

// Facebook's native scheduler only accepts times 10 min – 30 days out.
// Anything sooner than 10 min (or in the past) we just publish immediately.
const INSTANT_WINDOW_MS = 10 * 60 * 1000;
const MAX_SCHEDULE_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class PostsService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly queuesService: QueuesService,
  ) {}

  async list() {
    const supabase = this.supabaseService.createServiceClient();

    const [
      { data: accounts, error: accountsError },
      { data: posts, error: postsError },
      { data: authors },
      { data: apiKeyRows },
    ] = await Promise.all([
      supabase
        .from("social_accounts")
        .select("*")
        .eq("user_id", OWNER_ID)
        .order("created_at", { ascending: false }),
      supabase
        .from("scheduled_posts")
        .select("*, post_targets(*, social_accounts(id, display_name, platform, avatar_url))")
        .eq("user_id", OWNER_ID)
        .order("scheduled_for", { ascending: false })
        .limit(100),
      supabase.from("profiles").select("id, display_name, email, division_id"),
      supabase.from("api_keys").select("*").order("created_at", { ascending: false }),
    ]);

    if (accountsError || postsError) {
      throw new InternalServerErrorException(accountsError?.message || postsError?.message);
    }

    // Map API keys explicitly — the pg shim ignores column projection (always
    // `select *`), and key_hash must never reach the client. Lets the UI resolve
    // scheduled_posts.api_key_id → a human key name.
    const apiKeys = (apiKeyRows || []).map((k: any) => ({
      id: k.id,
      name: k.name,
      key_prefix: k.key_prefix,
      revoked_at: k.revoked_at,
    }));

    return { accounts, posts, authors: authors || [], apiKeys };
  }

  async create(payload: any, author: any) {
    const supabase = this.supabaseService.createServiceClient();

    const {
      body,
      imageUrl,
      media,
      linkUrl,
      scheduledFor,
      socialAccountIds,
      contentType,
      tags,
      templateId,
      firstComment,
      linkInComment,
      saveAs,
      platformCaptions,
      platformOptions: platformOptionsInput,
      source,
      apiKeyId,
      autoApproveAt,
    } = payload || {};
    const accountIds = Array.isArray(socialAccountIds) ? socialAccountIds : [];
    // Origin: "app" (composer, default) unless a caller passes it — the external
    // Developer API sets source:"api" + apiKeyId so posts are attributable.
    const postSource = source || "app";
    const postApiKeyId = apiKeyId || null;
    // Per-platform caption overrides / options (nullable jsonb columns).
    const pCaptions = sanitizePlatformCaptions(platformCaptions);
    const pOptions = sanitizePlatformOptions(platformOptionsInput);

    // Ordered media list [{url, type: "image"|"video"}]. imageUrl is the
    // legacy single-image field — fold it in so older clients keep working.
    const mediaList = (Array.isArray(media) ? media : [])
      .filter((m: any) => m?.url)
      .map((m: any) => ({ url: m.url, type: m.type === "video" ? "video" : "image" }));
    if (!mediaList.length && imageUrl) mediaList.push({ url: imageUrl, type: "image" });
    // First image doubles as the thumbnail in calendar/queue cards.
    const firstImage = mediaList.find((m) => m.type === "image")?.url || null;

    const cType = normalizeContentType(contentType);
    if (!isValidContentType(cType)) {
      throw new BadRequestException(`Invalid contentType "${contentType}" — use ${CONTENT_TYPES_HINT}.`);
    }

    // Free-form editorial tags. Normalized here (not in the composer) so the
    // Developer API and CSV import produce identical rows — see postFields.js.
    const postTags = normalizeTags(tags);

    // The workspace "link in first comment" policy is applied here rather than in
    // the composer, so the Developer API and CSV import honor it too. `linkInComment`
    // overrides the setting for this post; the append is idempotent, so the link the
    // composer already added client-side is not duplicated. See lib/postFields.js.
    const resolvedFirstComment = await resolveFirstComment(supabase, OWNER_ID, {
      firstComment,
      linkUrl,
      linkInComment,
    });

    // Draft / submit-for-review: store without publishing or scheduling on Facebook.
    if (saveAs === "draft" || saveAs === "review") {
      if (!body?.trim() || !accountIds.length) {
        throw new BadRequestException("Post text and at least one Page are required.");
      }
      const status = saveAs === "review" ? "pending_review" : "draft";
      const { data: dPost, error: dErr } = await supabase
        .from("scheduled_posts")
        .insert({
          user_id: OWNER_ID,
          body: body.trim(),
          image_url: firstImage,
          media: mediaList.length ? mediaList : null,
          link_url: linkUrl || null,
          scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : new Date().toISOString(),
          status,
          approval_status: saveAs === "review" ? "pending" : "none",
          // Review posts inherit the shared auto-approve grace window (null when
          // auto-approve is off) — so API/composer submissions behave the same
          // as the in-app "Submit for review".
          //
          // A caller may override that window per post by passing `autoApproveAt`
          // (an ISO string, or null for "hold for a human however the global
          // setting is configured"). Only the Developer API sets it today: an
          // automation that scores its own output wants a confident item to clear
          // in minutes and a borderline one to wait for review, and one global
          // window cannot express both. `undefined` means "not specified" and
          // keeps the shared setting — note the distinction from an explicit null.
          auto_approve_at:
            saveAs === "review"
              ? autoApproveAt !== undefined
                ? autoApproveAt
                : await computeAutoApproveAt(supabase, OWNER_ID)
              : null,
          content_type: cType || null,
          template_id: templateId || null,
          first_comment: resolvedFirstComment,
          tags: postTags,
          platform_captions: pCaptions,
          platform_options: pOptions,
          source: postSource,
          api_key_id: postApiKeyId,
          created_by: author?.id || null,
        })
        .select()
        .single();
      if (dErr) throw new InternalServerErrorException(dErr.message);

      const { data: accts } = await supabase
        .from("social_accounts")
        .select("id,platform")
        .in("id", accountIds)
        .eq("user_id", OWNER_ID);
      if (accts?.length) {
        await supabase
          .from("post_targets")
          .insert(accts.map((a) => ({ post_id: dPost.id, social_account_id: a.id, platform: a.platform, status })));
      }
      await logActivity({
        type: saveAs === "review" ? "post.submitted" : "post.draft",
        title: saveAs === "review" ? "Submitted a post for review" : "Saved a draft",
        status: "info",
        meta: { postId: dPost.id },
      });
      return { post: dPost, saved: saveAs };
    }

    // "Add to queue": resolve the next open posting slot for the selected
    // accounts and schedule into it — no explicit time needed.
    let effectiveScheduledFor = scheduledFor;
    if (saveAs === "queue") {
      if (!body?.trim() || !accountIds.length) {
        throw new BadRequestException("Post text and at least one Page are required.");
      }
      effectiveScheduledFor = await this.queuesService.nextOpenSlot(accountIds);
    }

    if (!body?.trim() || !effectiveScheduledFor || !accountIds.length) {
      throw new BadRequestException("Post text, schedule time, and at least one Page are required.");
    }

    const scheduledDate = new Date(effectiveScheduledFor);
    if (Number.isNaN(scheduledDate.getTime())) {
      throw new BadRequestException("Invalid schedule time.");
    }

    const diffMs = scheduledDate.getTime() - Date.now();
    if (diffMs > MAX_SCHEDULE_MS) {
      throw new BadRequestException("Facebook can only schedule up to 30 days ahead.");
    }

    // Within 10 minutes (or in the past) → publish immediately instead of scheduling.
    const publishNow = diffMs <= INSTANT_WINDOW_MS;
    const initialStatus = publishNow ? "publishing" : "scheduled";

    const { data: accounts, error: accountsError } = await supabase
      .from("social_accounts")
      .select("*")
      .in("id", accountIds)
      .eq("user_id", OWNER_ID);

    if (accountsError || !accounts?.length) {
      throw new NotFoundException("Selected accounts were not found.");
    }

    // Instagram cannot publish text-only posts — catch it up front instead of
    // failing per-target at publish time.
    if (!mediaList.length && accounts.some((a) => a.platform === "instagram")) {
      throw new BadRequestException("Instagram posts require an image or video — attach media or deselect the Instagram account.");
    }
    if (!mediaList.some((m) => m.type === "video") && accounts.some((a) => a.platform === "youtube")) {
      throw new BadRequestException("YouTube posts require a video — attach one or deselect the YouTube channel.");
    }
    // Facebook Reel/Story media requirements (format from platform_options).
    if (accounts.some((a) => a.platform === "facebook")) {
      const fbFmt = pOptions?.facebook?.format || "post";
      const videoCount = mediaList.filter((m) => m.type === "video").length;
      if (fbFmt === "reel" && (videoCount !== 1 || mediaList.length !== 1)) {
        throw new BadRequestException("A Facebook Reel needs exactly one video (no images).");
      }
      if (fbFmt === "story" && mediaList.length !== 1) {
        throw new BadRequestException("A Facebook Story needs exactly one image or video.");
      }
    }

    // Compliance is advisory only — flags are shown in the UI but never block
    // posting or scheduling. This is intentional during the iterative rollout.
    runCompliance({ body, linkUrl, imageUrl: firstImage, contentType: cType, accounts });

    const { data: post, error: postError } = await supabase
      .from("scheduled_posts")
      .insert({
        user_id: OWNER_ID,
        body: body.trim(),
        image_url: firstImage,
        media: mediaList.length ? mediaList : null,
        link_url: linkUrl || null,
        content_type: cType || null,
        template_id: templateId || null,
        first_comment: resolvedFirstComment,
        tags: postTags,
        platform_captions: pCaptions,
        platform_options: pOptions,
        source: postSource,
        api_key_id: postApiKeyId,
        created_by: author?.id || null,
        scheduled_for: (publishNow ? new Date() : scheduledDate).toISOString(),
        status: initialStatus,
      })
      .select()
      .single();

    if (postError) throw new InternalServerErrorException(postError.message);

    // UTM click tracking (opt-in via Settings): tag the outbound link once,
    // then persist so the stored post matches what actually went out.
    let outboundLink = linkUrl || null;
    if (outboundLink && (await utmTrackingEnabled())) {
      outboundLink = appendUtm(outboundLink, { postId: post.id });
      await supabase.from("scheduled_posts").update({ link_url: outboundLink }).eq("id", post.id);
    }

    const results: any[] = [];

    for (const account of accounts) {
      const { error: targetError } = await supabase.from("post_targets").insert({
        post_id: post.id,
        social_account_id: account.id,
        platform: account.platform,
        status: initialStatus,
      });

      if (targetError) {
        results.push({ accountId: account.id, status: "failed", error: targetError.message });
        continue;
      }

      try {
        // Per-platform caption override (falls back to the master body).
        const postData = { ...postForPlatform(post, account.platform), link_url: outboundLink };
        let result, targetStatus, sentAt = null;

        // Only YouTube keeps native scheduling (resumable upload + publishAt
        // flip). Everything else is published from OUR cron queue when the
        // scheduled time arrives (/api/cron/publish) — including Facebook feed
        // posts. Meta's native scheduler owns the publish moment and never lets
        // us attach the first comment afterwards, so we schedule FB ourselves
        // too, exactly like IG/Threads/X and FB Reels/Stories.
        if (account.platform !== "youtube" && !publishNow) {
          results.push({ accountId: account.id, name: account.display_name, status: "scheduled", queued: true });
          continue;
        }

        assertPublishable(account);

        if (account.publish_via === "postiz") {
          // Threads / standalone Instagram / X, relayed through Postiz. Checked
          // before the platform branches because such an account still carries
          // its real platform ("threads"/"instagram"/"twitter") and must not
          // reach the native libs. Postiz has no add-comment endpoint, so the
          // first comment travels with the post and firstCommentIncluded tells
          // the block below to skip its own.
          result = await publishPostizPost({
            account,
            post: postData,
            options: platformOptions(post, account.platform),
            firstComment: resolvedFirstComment,
          });
          targetStatus = "sent";
          sentAt = new Date().toISOString();
        } else if (account.platform === "youtube") {
          // Real end-to-end upload. For future posts YouTube's NATIVE
          // scheduling is used: the video uploads now as private with
          // status.publishAt and goes public at the scheduled time.
          result = await publishYouTubeVideo({
            account,
            post: postData,
            scheduledFor: publishNow ? null : effectiveScheduledFor,
            options: platformOptions(post, "youtube"),
          });
          targetStatus = publishNow ? "sent" : "scheduled";
          if (publishNow) sentAt = new Date().toISOString();
        } else if (account.platform === "instagram") {
          result = await publishInstagramPost({ account, post: postData });
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
          .eq("post_id", post.id)
          .eq("social_account_id", account.id);

        // Best-effort first comment — only possible once a post is actually live
        // (immediate publish). A native-scheduler post can't get one from here
        // since this route isn't invoked again when Facebook publishes it later.
        // Stories have no comments — skip them.
        // Postiz already submitted the comment as part of the post (it has no
        // add-comment endpoint), so don't post a second one.
        const isStory = account.platform === "facebook" && fbFormat(post) === "story";
        if (targetStatus === "sent" && !isStory && !result.firstCommentIncluded && resolvedFirstComment && result.externalPostId) {
          try {
            if (account.platform === "instagram") {
              await postInstagramComment({ account, mediaId: result.externalPostId, message: resolvedFirstComment });
            } else if (account.platform === "facebook") {
              await postFacebookComment({ account, postId: result.externalPostId, message: resolvedFirstComment });
            }
          } catch (commentError) {
            console.warn(`[posts] first comment failed for ${account.display_name}:`, commentError.message);
          }
        }

        if (targetStatus === "sent") await clearAccountPublishFailure(account);

        results.push({
          accountId: account.id,
          name: account.display_name,
          status: targetStatus,
          externalPostId: result.externalPostId,
        });
      } catch (err) {
        await supabase
          .from("post_targets")
          .update({ status: "failed", last_error: err.message })
          .eq("post_id", post.id)
          .eq("social_account_id", account.id);
        await noteAccountPublishFailure(account, err.message);

        results.push({ accountId: account.id, name: account.display_name, status: "failed", error: err.message });
      }
    }

    const allFailed = results.every((r) => r.status === "failed");
    const anyFailed = results.some((r) => r.status === "failed");
    const allSent = publishNow && results.every((r) => r.status === "sent");

    const finalStatus = allFailed ? "failed" : publishNow ? "sent" : "scheduled";
    await supabase
      .from("scheduled_posts")
      .update({ status: finalStatus, sent_at: allSent ? new Date().toISOString() : null })
      .eq("id", post.id);

    await logActivity({
      type: allFailed ? "post.failed" : publishNow ? "post.published" : "post.scheduled",
      title: allFailed
        ? `Post failed on all pages`
        : publishNow
          ? `Published to ${results.filter((r) => r.status === "sent").length} page(s)`
          : `Scheduled to ${results.filter((r) => r.status === "scheduled").length} page(s)`,
      status: allFailed ? "error" : anyFailed ? "warning" : "success",
      meta: { postId: post.id, results: results.map((r) => ({ name: r.name, status: r.status })) },
    });

    return {
      post,
      results,
      publishedNow: publishNow,
      warning: anyFailed && !allFailed ? "Some pages failed." : null,
    };
  }

  // PATCH /api/posts/:id — edit caption / link / schedule time.
  async update(id: string, payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { body, linkUrl, scheduledFor } = payload || {};

    const { data: post } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(*))")
      .eq("id", id)
      .eq("user_id", OWNER_ID)
      .single();

    if (!post) throw new NotFoundException("Post not found.");
    if (post.status === "sent" || post.status === "publishing") {
      throw new ConflictException("Only scheduled or failed posts can be edited.");
    }
    if (body !== undefined && !body.trim()) {
      throw new BadRequestException("Caption can't be empty.");
    }

    const warnings: string[] = [];
    for (const target of post.post_targets || []) {
      if (target.status === "scheduled" && target.platform === "facebook" && target.external_post_id) {
        try {
          await updateScheduledFacebookPost({
            account: target.social_accounts,
            externalPostId: target.external_post_id,
            message: body !== undefined ? body.trim() : undefined,
            scheduledFor: scheduledFor || undefined,
          });
        } catch (e) {
          warnings.push(`${target.social_accounts?.display_name || "Page"}: ${e.message}`);
        }
      }
      // YouTube schedules natively on the video, so push the new time to it too.
      if (scheduledFor && target.status === "scheduled" && target.platform === "youtube" && target.external_post_id) {
        try {
          await updateScheduledYouTubeVideo({
            account: target.social_accounts,
            videoId: target.external_post_id,
            scheduledFor,
          });
        } catch (e) {
          warnings.push(`${target.social_accounts?.display_name || "Channel"}: ${e.message}`);
        }
      }
    }

    const update: any = {};
    if (body !== undefined) update.body = body.trim();
    if (linkUrl !== undefined) update.link_url = linkUrl || null;
    if (scheduledFor) update.scheduled_for = new Date(scheduledFor).toISOString();

    const { data: updated, error } = await supabase
      .from("scheduled_posts")
      .update(update)
      .eq("id", id)
      .eq("user_id", OWNER_ID)
      .select("*, post_targets(*, social_accounts(id, display_name, platform, avatar_url))")
      .single();

    if (error) throw new InternalServerErrorException(error.message);
    return { post: updated, warnings: warnings.length ? warnings.join("; ") : null };
  }

  // DELETE /api/posts/:id
  async remove(id: string) {
    const supabase = this.supabaseService.createServiceClient();

    const { data: post } = await supabase
      .from("scheduled_posts")
      .select("id, status")
      .eq("id", id)
      .eq("user_id", OWNER_ID)
      .single();

    if (!post) throw new NotFoundException("Post not found.");
    if (post.status === "publishing") {
      throw new ConflictException("Cannot delete a post that is currently publishing.");
    }

    const { error: deleteError } = await supabase
      .from("scheduled_posts")
      .delete()
      .eq("id", id)
      .eq("user_id", OWNER_ID);

    if (deleteError) throw new InternalServerErrorException(deleteError.message);
    return { ok: true };
  }

  // POST /api/posts/bulk — delete or reschedule many at once.
  async bulk(payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { action, ids, scheduledFor } = payload || {};

    if (!Array.isArray(ids) || !ids.length) {
      throw new BadRequestException("No posts selected.");
    }

    const { data: posts, error: fetchError } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(*))")
      .in("id", ids)
      .eq("user_id", OWNER_ID);

    if (fetchError) throw new InternalServerErrorException(fetchError.message);

    const eligible = (posts || []).filter((p) => p.status !== "publishing" && p.status !== "sent");
    const skipped = (posts || []).length - eligible.length;

    if (action === "delete") {
      const eligibleIds = eligible.map((p) => p.id);
      if (eligibleIds.length) {
        const { error } = await supabase
          .from("scheduled_posts")
          .delete()
          .in("id", eligibleIds)
          .eq("user_id", OWNER_ID);
        if (error) throw new InternalServerErrorException(error.message);
      }
      await logActivity({ type: "post.bulk_deleted", title: `Deleted ${eligibleIds.length} post(s)`, status: "info" });
      return { ok: true, affected: eligible.length, skipped };
    }

    if (action === "reschedule") {
      if (!scheduledFor) throw new BadRequestException("scheduledFor is required.");
      const newDate = new Date(scheduledFor);
      if (Number.isNaN(newDate.getTime())) throw new BadRequestException("Invalid date.");

      let affected = 0;
      for (const post of eligible) {
        for (const target of post.post_targets || []) {
          if (target.status === "scheduled" && target.platform === "facebook" && target.external_post_id) {
            try {
              await updateScheduledFacebookPost({
                account: target.social_accounts,
                externalPostId: target.external_post_id,
                scheduledFor: newDate,
              } as any);
            } catch (e) {
              console.warn(`[posts/bulk] reschedule push failed for ${post.id}:`, e.message);
            }
          }
          // YouTube schedules natively on the video, so push the new time to it too.
          if (target.status === "scheduled" && target.platform === "youtube" && target.external_post_id) {
            try {
              await updateScheduledYouTubeVideo({
                account: target.social_accounts,
                videoId: target.external_post_id,
                scheduledFor: newDate,
              } as any);
            } catch (e) {
              console.warn(`[posts/bulk] YouTube reschedule push failed for ${post.id}:`, e.message);
            }
          }
        }
        const { error } = await supabase
          .from("scheduled_posts")
          .update({ scheduled_for: newDate.toISOString() })
          .eq("id", post.id)
          .eq("user_id", OWNER_ID);
        if (!error) affected++;
      }
      await logActivity({ type: "post.bulk_rescheduled", title: `Rescheduled ${affected} post(s)`, status: "info" });
      return { ok: true, affected, skipped };
    }

    throw new BadRequestException("Unknown action.");
  }

  // POST /api/posts/recycle — clone a post back into the queue.
  async recycle(payload: any, author: any) {
    const supabase = this.supabaseService.createServiceClient();

    const { postId, scheduledFor } = payload || {};
    if (!postId) throw new BadRequestException("postId is required.");

    const { data: post, error } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(social_account_id, platform)")
      .eq("id", postId)
      .eq("user_id", OWNER_ID)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!post) throw new NotFoundException("Post not found.");

    let when = scheduledFor ? new Date(scheduledFor) : new Date(new Date(post.scheduled_for).getTime());
    if (!scheduledFor) {
      when = new Date(post.scheduled_for);
      when.setFullYear(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1);
    }
    if (Number.isNaN(when.getTime())) throw new BadRequestException("Invalid schedule time.");
    if (when.getTime() < Date.now() + 5 * 60 * 1000) {
      throw new BadRequestException("Recycle time must be at least 5 minutes from now.");
    }

    const { data: clone, error: cloneError } = await supabase
      .from("scheduled_posts")
      .insert({
        user_id: OWNER_ID,
        body: post.body,
        image_url: post.image_url,
        media: post.media || null,
        link_url: post.link_url,
        first_comment: post.first_comment,
        template_id: post.template_id,
        platform_captions: post.platform_captions || null,
        platform_options: post.platform_options || null,
        scheduled_for: when.toISOString(),
        status: "scheduled",
        source: "recycle",
        created_by: author?.id || null,
      })
      .select()
      .single();
    if (cloneError) throw new InternalServerErrorException(cloneError.message);

    const targets = (post.post_targets || []).map((t) => ({
      post_id: clone.id,
      social_account_id: t.social_account_id,
      platform: t.platform,
      status: "scheduled",
    }));
    if (targets.length) {
      const { error: targetError } = await supabase.from("post_targets").insert(targets);
      if (targetError) {
        await supabase.from("scheduled_posts").delete().eq("id", clone.id);
        throw new InternalServerErrorException(targetError.message);
      }
    }

    await logActivity({
      type: "post.recycled",
      title: `Recycled a post for ${when.toLocaleString()}`,
      status: "info",
      meta: { sourcePostId: post.id, newPostId: clone.id },
    });
    return { post: clone };
  }

  // POST /api/posts/import — bulk CSV import (rows parsed client-side).
  async importCsv(payload: any, author: any) {
    const supabase = this.supabaseService.createServiceClient();
    const MAX_ROWS = 200;

    const { rows } = payload || {};
    if (!Array.isArray(rows) || !rows.length) {
      throw new BadRequestException("No rows to import.");
    }
    if (rows.length > MAX_ROWS) {
      throw new BadRequestException(`Too many rows — max ${MAX_ROWS} per import.`);
    }

    const { data: accounts, error: acctError } = await supabase
      .from("social_accounts")
      .select("id, platform, display_name")
      .eq("user_id", OWNER_ID);
    if (acctError) throw new InternalServerErrorException(acctError.message);
    const byName = new Map((accounts || []).map((a) => [a.display_name.trim().toLowerCase(), a]));
    // Read the workspace "link in first comment" policy once, not per row.
    const appendLink = await linkInFirstCommentEnabled(supabase, OWNER_ID);

    let created = 0;
    const errors: any[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const rowNum = i + 2;

      const text = (row.text || "").trim();
      if (!text) {
        errors.push({ row: rowNum, error: "Missing post text." });
        continue;
      }

      const when = new Date(row.scheduledFor);
      if (!row.scheduledFor || Number.isNaN(when.getTime())) {
        errors.push({ row: rowNum, error: "Invalid or missing schedule date/time." });
        continue;
      }

      const pagesField = (row.pages || "").trim();
      let targets;
      if (!pagesField || pagesField.toLowerCase() === "all") {
        targets = accounts || [];
      } else {
        targets = [];
        const misses: string[] = [];
        for (const name of pagesField.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
          const acct = byName.get(name.toLowerCase());
          if (acct) targets.push(acct);
          else misses.push(name);
        }
        if (misses.length) {
          errors.push({ row: rowNum, error: `Unknown page(s): ${misses.join(", ")}` });
          continue;
        }
      }
      if (!targets.length) {
        errors.push({ row: rowNum, error: "No pages matched." });
        continue;
      }

      const contentTypeRaw = normalizeContentType(row.contentType);
      if (!isValidContentType(contentTypeRaw)) {
        errors.push({
          row: rowNum,
          error: `Invalid content_type "${row.contentType}" — use ${CONTENT_TYPES_HINT}.`,
        });
        continue;
      }

      // CSV rows carry a single imageUrl and/or videoUrl — fold into media.
      const rowImage = (row.imageUrl || "").trim() || null;
      const rowVideo = (row.videoUrl || "").trim() || null;
      const rowMedia = [
        ...(rowImage ? [{ url: rowImage, type: "image" }] : []),
        ...(rowVideo ? [{ url: rowVideo, type: "video" }] : []),
      ];

      const { data: post, error: postError } = await supabase
        .from("scheduled_posts")
        .insert({
          user_id: OWNER_ID,
          body: text,
          image_url: rowImage,
          media: rowMedia.length ? rowMedia : null,
          link_url: (row.linkUrl || "").trim() || null,
          first_comment: composeFirstComment({
            firstComment: row.firstComment,
            linkUrl: row.linkUrl,
            appendLink,
          }),
          content_type: contentTypeRaw || null,
          // normalizeTags accepts a comma-separated string, which is what a CSV
          // cell gives us — so a `tags` column needs no extra parsing here.
          tags: normalizeTags(row.tags),
          scheduled_for: when.toISOString(),
          status: "scheduled",
          source: "csv",
          created_by: author?.id || null,
        })
        .select()
        .single();
      if (postError) {
        errors.push({ row: rowNum, error: postError.message });
        continue;
      }

      const { error: targetError } = await supabase.from("post_targets").insert(
        targets.map((a) => ({ post_id: post.id, social_account_id: a.id, platform: a.platform, status: "scheduled" })),
      );
      if (targetError) {
        await supabase.from("scheduled_posts").delete().eq("id", post.id);
        errors.push({ row: rowNum, error: targetError.message });
        continue;
      }
      created++;
    }

    await logActivity({
      type: "post.imported",
      title: `Imported ${created} post(s) from CSV${errors.length ? ` (${errors.length} row(s) skipped)` : ""}`,
      status: errors.length ? "warning" : "success",
      meta: { created, errors: errors.slice(0, 10) },
    });

    return { created, errors };
  }

  // Best-effort first comment for a Facebook post that just went live via the
  // native scheduler (reached only from verify() when a scheduled FB target
  // flips to sent). Mirrors the immediate-publish first-comment behaviour and,
  // like it, never fails the reconciliation itself. Gated on target.status ===
  // "scheduled" at the call sites, so it runs exactly once per target.
  private async postFacebookFirstComment(account: any, post: any, externalPostId: string) {
    if (!post?.first_comment?.trim() || !externalPostId) return;
    try {
      await postFacebookComment({ account, postId: externalPostId, message: post.first_comment });
    } catch (e: any) {
      console.warn(`[verify] first comment failed for ${account.display_name}:`, e.message);
    }
  }

  // POST /api/posts/verify — reconcile recent posts against the FB Graph API.
  async verify() {
    const supabase = this.supabaseService.createServiceClient();

    const { data: posts, error } = await supabase
      .from("scheduled_posts")
      .select(
        "id, body, first_comment, status, sent_at, scheduled_for, post_targets(id, status, external_post_id, sent_at, permalink, social_accounts(id, display_name, access_token, platform, publish_via, external_account_id, metadata))",
      )
      .eq("user_id", OWNER_ID)
      .in("status", ["sent", "scheduled", "publishing"])
      .order("scheduled_for", { ascending: false })
      .limit(100);
    if (error) throw new InternalServerErrorException(error.message);

    let checked = 0,
      deleted = 0,
      published = 0;

    for (const post of posts || []) {
      let postChanged = false;
      const targetStatuses: string[] = [];

      for (const target of post.post_targets || []) {
        const account: any = target.social_accounts;
        if (
          !target.external_post_id ||
          target.external_post_id.includes("_mock_") ||
          !account ||
          !["facebook", "instagram", "threads", "twitter", "youtube"].includes(account.platform) ||
          !["sent", "scheduled", "publishing"].includes(target.status) ||
          // Reels/Stories are exempt: stories expire after 24h (a 404 is NOT a
          // deletion) and reel video-ids need a different status lookup.
          (account.platform === "facebook" && fbFormat(post) !== "post")
        ) {
          targetStatuses.push(target.status);
          continue;
        }

        // Postiz-backed targets (Threads / personal Instagram) reconcile against
        // Postiz instead: it reports a publish error and hands back a permalink,
        // but gives no trustworthy signal that a post was removed on the
        // platform, so they stay exempt from deletion sync.
        if (account.publish_via === "postiz") {
          await reconcilePostizTarget(target);
          targetStatuses.push(target.status);
          continue;
        }

        checked++;
        let result;
        try {
          if (account.platform === "facebook") {
            result = await checkFacebookPostStatus({ account, externalPostId: target.external_post_id });
          } else if (account.platform === "youtube") {
            // isPublished flips true when YouTube's native publishAt fires —
            // that drives the scheduled → sent transition below.
            result = await checkYouTubeVideoStatus({ account, videoId: target.external_post_id });
          } else if (account.platform === "instagram") {
            // IG/X posts are always live once sent — only existence matters.
            result = { ...(await checkInstagramPostStatus({ account, externalPostId: target.external_post_id })), isPublished: true };
          } else {
            // Native Threads and X publishing were retired in favour of Postiz,
            // which the branch above handles — nothing else should reach here,
            // and exists:null leaves the target untouched if anything does.
            result = { exists: null };
          }
        } catch {
          result = { exists: null };
        }

        const PLATFORM_LABELS: any = {
          facebook: "Facebook",
          instagram: "Instagram",
          threads: "Threads",
          twitter: "X",
          youtube: "YouTube",
        };
        const platformName = PLATFORM_LABELS[account.platform] || "Facebook";

        if (result.exists === false) {
          const { error: updateError } = await supabase
            .from("post_targets")
            .update({ status: "deleted", last_error: `This post was deleted on ${platformName}.` })
            .eq("id", target.id);
          if (updateError) {
            console.error("[verify] couldn't mark target deleted:", updateError.message);
            targetStatuses.push(target.status);
            continue;
          }
          targetStatuses.push("deleted");
          deleted++;
          postChanged = true;
          await logActivity({
            type: "post.deleted",
            title: `Post deleted on ${platformName} — ${account.display_name}`,
            status: "warning",
            meta: { postId: post.id, page: account.display_name, preview: post.body.slice(0, 80) },
          });
        } else if (result.exists === true && result.isPublished && target.status === "scheduled") {
          await supabase
            .from("post_targets")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", target.id);
          targetStatuses.push("sent");
          published++;
          postChanged = true;
          // The post just went live via the native scheduler — this is the only
          // moment we can post its first comment (the immediate-publish paths
          // never ran for it). FB only; YouTube has no first-comment support here.
          if (account.platform === "facebook") {
            await this.postFacebookFirstComment(account, post, target.external_post_id);
          }
          await logActivity({
            type: "post.published",
            title: `Scheduled post went live — ${account.display_name}`,
            status: "success",
            meta: { postId: post.id, page: account.display_name },
          });
        } else if (
          account.platform === "facebook" &&
          result.exists === true &&
          !result.isPublished &&
          target.status === "scheduled" &&
          post.scheduled_for &&
          Date.now() - new Date(post.scheduled_for).getTime() > 15 * 60 * 1000
        ) {
          // Stuck "dark post": created with published:false but Facebook never
          // auto-published it, and its scheduled time is well past. Its
          // permalink shows "content isn't available" to everyone except
          // admins — force is_published:true to recover it.
          try {
            await publishUnpublishedFacebookPost({ account, externalPostId: target.external_post_id });
            await supabase
              .from("post_targets")
              .update({ status: "sent", sent_at: new Date().toISOString(), last_error: null })
              .eq("id", target.id);
            targetStatuses.push("sent");
            published++;
            postChanged = true;
            // Recovered a stuck dark post — now that it's live, post its first comment.
            await this.postFacebookFirstComment(account, post, target.external_post_id);
            await logActivity({
              type: "post.published",
              title: `Recovered a stuck scheduled post — ${account.display_name}`,
              status: "warning",
              meta: { postId: post.id, page: account.display_name },
            });
          } catch (e) {
            console.warn(`[verify] couldn't recover stuck post on ${account.display_name}:`, e.message);
            targetStatuses.push(target.status);
          }
        } else {
          targetStatuses.push(target.status);
        }
      }

      if (!postChanged || !targetStatuses.length) continue;

      let newStatus = post.status;
      if (targetStatuses.every((s) => s === "deleted")) newStatus = "deleted";
      else if (targetStatuses.every((s) => s === "sent" || s === "deleted")) newStatus = "sent";
      if (newStatus !== post.status) {
        const patch: any = { status: newStatus };
        if (newStatus === "sent" && !post.sent_at) patch.sent_at = new Date().toISOString();
        await supabase.from("scheduled_posts").update(patch).eq("id", post.id);
      }
    }

    return { checked, deleted, published };
  }
}
