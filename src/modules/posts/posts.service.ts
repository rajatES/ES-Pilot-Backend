import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { QueuesService } from "../queues/queues.service";
import { PublisherService } from "../publisher/publisher.service";
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
import { publishPostizPost, reconcilePostizTarget, POSTIZ_REJECTED_ERROR } from "../../lib/postiz";
import { publishYouTubeVideo, checkYouTubeVideoStatus, updateScheduledYouTubeVideo } from "../../lib/youtube";
import { logActivity } from "../../lib/activity";
import { appendUtm, utmTrackingEnabled } from "../../lib/utm";
import { runCompliance } from "../../lib/compliance";
import {
  assertPublishable,
  isLocked,
  lockedAccountNames,
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

// How far back the Error tab reaches by default, and the row cap that keeps one
// bad week from returning an unbounded result. 90 days is long enough to cover
// "did that campaign actually go out?" and short enough that the query stays a
// simple indexed scan on post_targets.status + created_at. Callers can narrow
// it with ?days=N; the response reports `truncated` so the UI can say so rather
// than quietly showing a partial list — the failure this whole endpoint exists
// to stop repeating.
const FAILURE_WINDOW_DAYS = 90;
const FAILURE_LIMIT = 1000;

@Injectable()
export class PostsService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly queuesService: QueuesService,
    private readonly publisher: PublisherService,
  ) {}

  // Has this process already filled publish_rejected_at for the rows that
  // predate the column? See backfillRejectedTargets().
  private rejectedBackfilled = false;

  // One-time fill of post_targets.publish_rejected_at for failures recorded
  // before that column existed.
  //
  // It matters because nothing would ever fill them otherwise: the verify sweep
  // that sets the column only looks at posts still "sent"/"publishing" within
  // 24h, and a rejection has already moved its target to "failed". Without this
  // every platform-rejected delivery from before today would stay permanently
  // un-re-sendable — the exact complaint this change answers.
  //
  // The evidence is POSTIZ_REJECTED_ERROR compared with `=`: a constant this
  // codebase writes, from the one path that writes it, and only when Postiz
  // reported state ERROR. That is a different thing from reading meaning out of
  // vendor error text, which must never decide that a re-send is safe.
  //
  // Lazy and once per process, the same shape as the sports/design-template
  // seeds: after the first run nothing matches, and a failure here is logged and
  // left for the next boot rather than breaking the page that triggered it.
  private async backfillRejectedTargets(supabase: any) {
    if (this.rejectedBackfilled) return;
    this.rejectedBackfilled = true; // set first: the update is idempotent, and a
                                    // concurrent request should not run it twice
    try {
      const { data, error } = await supabase
        .from("post_targets")
        // now(), not the original moment — we cannot know when Postiz was asked,
        // only that it answered. The column is a marker, and nothing reads its
        // value as a timestamp.
        .update({ publish_rejected_at: new Date().toISOString() })
        .eq("status", "failed")
        .eq("last_error", POSTIZ_REJECTED_ERROR)
        .is("publish_rejected_at", null)
        .not("external_post_id", "is", null)
        // A permalink means Postiz handed back the URL of a LIVE post, so
        // whatever it flagged, the post went out. Production had 5 such rows
        // among 29 as of 2026-09-21: re-sending one would duplicate it on a
        // live page. Newer rows can't look like this — getPostizPostState now
        // separates the two — but these were written before it could.
        .is("permalink", null);
      if (error) throw new Error(error.message);
      if (data?.length) {
        console.log(`[posts] marked ${data.length} pre-existing platform-rejected target(s) as re-sendable.`);
      }
    } catch (e: any) {
      this.rejectedBackfilled = false;
      console.warn("[posts] could not backfill publish_rejected_at:", e.message);
    }
  }

  async list() {
    const supabase = this.supabaseService.createServiceClient();
    // Both this and failures() feed a Re-send button, so both need the backfill
    // to have run — otherwise the drawer and the Error tab would disagree about
    // whether the same failure can go out again.
    await this.backfillRejectedTargets(supabase);

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

  // GET /api/posts/failures — every failed delivery in the window, one row per
  // failed channel.
  //
  // A separate endpoint rather than a filter over list(), for two reasons the
  // Error tab could not work around:
  //
  //  1. list() is capped at the 100 most recent posts by scheduled_for. At ES's
  //     volume that is a few days, so a failure older than that was invisible in
  //     the UI no matter what the tab filtered on. Raising the cap would make
  //     EVERY tab pay for it.
  //  2. The unit of failure is the CHANNEL, not the post. A post fanned out to
  //     56 Threads channels that failed on one of them is not a failed post —
  //     post.status is legitimately "sent" — so nothing post-shaped can
  //     represent it. Asking post_targets directly does.
  //
  // "Regardless of the reason" is meant literally: this does not care whether
  // the failure came from the publish cron, publish-now, an approval publish, a
  // locked page, a stranded-target sweep, or the Postiz verify reconcile. It
  // reads the recorded outcome, so a failure mode added later is included
  // without touching this.
  async failures(query: any = {}) {
    const supabase = this.supabaseService.createServiceClient();
    await this.backfillRejectedTargets(supabase);

    const days = Math.min(Math.max(Number(query?.days) || FAILURE_WINDOW_DAYS, 1), 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Cleared rows are hidden by DEFAULT but never dropped from the response's
    // accounting: the count below always reflects them, and ?includeCleared=1
    // lists them. The rule this protects is the one FailureList.jsx exists for
    // — the feed must never be able to imply "no failures" when failures exist.
    const includeCleared = query?.includeCleared === "1" || query?.includeCleared === true;

    // Failed targets. Filtered on the target's own created_at because the pg
    // shim cannot filter on an embedded table — a target is always created
    // with its post, so this is the post's age too.
    let targetQuery = supabase
      .from("post_targets")
      .select("*, scheduled_posts(*), social_accounts(id, display_name, platform, avatar_url, publish_via)")
      .eq("status", "failed")
      .gte("created_at", since);
    if (!includeCleared) targetQuery = targetQuery.is("failure_cleared_at", null);

    // Posts that failed WITHOUT leaving a failed target behind. Rare but real:
    // publish-now marks the post failed if it could not even insert the
    // target row, and there is then no per-channel row to report. Without
    // this those failures would be the one class still missing.
    let postQuery = supabase
      .from("scheduled_posts")
      .select("*, post_targets(id, status)")
      .eq("user_id", OWNER_ID)
      .eq("status", "failed")
      .gte("scheduled_for", since);
    if (!includeCleared) postQuery = postQuery.is("failure_cleared_at", null);

    // The cleared tallies are counted SEPARATELY rather than inferred from the
    // rows above, because the rows are capped at FAILURE_LIMIT and a count that
    // silently stopped at the cap is precisely the kind of undercount this feed
    // must not produce.
    const [
      { data: targets, error: targetError },
      { data: posts, error: postError },
      { count: clearedTargets, error: clearedTargetError },
      { count: clearedPosts, error: clearedPostError },
    ] = await Promise.all([
      targetQuery.order("created_at", { ascending: false }).limit(FAILURE_LIMIT),
      postQuery.order("scheduled_for", { ascending: false }).limit(FAILURE_LIMIT),
      supabase
        .from("post_targets")
        .select("id", { count: "exact", head: true })
        .eq("status", "failed")
        .gte("created_at", since)
        .not("failure_cleared_at", "is", null),
      supabase
        .from("scheduled_posts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", OWNER_ID)
        .eq("status", "failed")
        .gte("scheduled_for", since)
        .not("failure_cleared_at", "is", null),
    ]);

    if (targetError || postError) {
      throw new InternalServerErrorException(targetError?.message || postError?.message);
    }

    const rows = (targets || [])
      // A target whose post is gone (hard-deleted) has nothing to show or open.
      .filter((t: any) => t.scheduled_posts && t.scheduled_posts.user_id === OWNER_ID)
      .map((t: any) => this.failureRow(t));

    const covered = new Set(rows.map((r: any) => r.postId));
    for (const post of posts || []) {
      if (covered.has(post.id)) continue;
      if ((post.post_targets || []).some((t: any) => t.status === "failed")) continue;
      rows.push({
        id: `post:${post.id}`,
        postId: post.id,
        targetId: null,
        // No channel to name — the post failed before it reached one.
        channel: null,
        accountId: null,
        platform: null,
        avatarUrl: null,
        publishVia: null,
        body: post.body || "",
        linkUrl: post.link_url || null,
        edited: false,
        createdBy: post.created_by || null,
        when: post.scheduled_for || post.created_at || null,
        error: post.last_error || "This post failed before it reached any page.",
        permalink: null,
        externalPostId: null,
        rejectedByPlatform: false,
        source: post.source || "app",
        clearedAt: post.failure_cleared_at || null,
      });
    }

    // Newest first across both sources. Nothing records a "failed at" time —
    // post_targets has only created_at — so the post's scheduled time is the
    // ordering key, which is also the timestamp a reader recognises.
    rows.sort((a: any, b: any) => String(b.when || "").localeCompare(String(a.when || "")));

    return {
      failures: rows,
      days,
      truncated: (targets || []).length >= FAILURE_LIMIT,
      // Always present, whether or not cleared rows were requested — the feed
      // has to be able to say "and N more are hidden" instead of looking empty.
      //
      // NULL, never 0, if the tally itself failed. Reporting "0 hidden" off a
      // broken count would claim the list is complete when it might not be,
      // which is the one lie this endpoint must never tell; null lets the UI
      // say "some may be hidden" instead.
      cleared:
        clearedTargetError || clearedPostError ? null : (clearedTargets || 0) + (clearedPosts || 0),
      includingCleared: includeCleared,
    };
  }

  // One failed target, flattened for the UI. Kept separate so the shape is
  // defined in exactly one place.
  private failureRow(target: any) {
    const post = target.scheduled_posts || {};
    const account = target.social_accounts || {};
    return {
      id: target.id,
      postId: target.post_id,
      targetId: target.id,
      channel: account.display_name || "Unknown channel",
      accountId: target.social_account_id || account.id || null,
      platform: account.platform || target.platform || null,
      avatarUrl: account.avatar_url || null,
      publishVia: account.publish_via || null,
      // The copy THIS page was sent, which is the post's unless an earlier
      // re-send edited it for this page alone. Shown, searched and — when the
      // row is edited again before re-sending — pre-filled from here, so the
      // Error tab never offers back a caption that was already replaced.
      body: target.content_override?.body ?? post.body ?? "",
      linkUrl: (target.content_override && "linkUrl" in target.content_override
        ? target.content_override.linkUrl
        : post.link_url) || null,
      edited: !!target.content_override,
      createdBy: post.created_by || null,
      when: post.scheduled_for || target.created_at || null,
      // Every failure path writes last_error. A blank one still gets a row —
      // "we don't know why" is information, and swallowing it would recreate
      // the exact problem this endpoint exists to fix.
      error: target.last_error || "Failed with no reason recorded.",
      permalink: target.permalink || null,
      externalPostId: target.external_post_id || null,
      // Whether the id above is known to be dead. The UI needs this to decide
      // whether to offer Re-send: an external_post_id normally means "live,
      // re-sending duplicates it", but a confirmed rejection means the opposite.
      // Mirrors the guard in retry(), which is what actually enforces it.
      rejectedByPlatform: !!target.publish_rejected_at,
      source: post.source || "app",
      clearedAt: target.failure_cleared_at || null,
    };
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

    // One of the targets is a locked page. assertPublishable would catch it at
    // send time, but that means accepting the post, creating its targets and
    // failing them one by one — so refuse here, where the author can still
    // deselect. Drafts are unaffected: that branch returns above.
    const locked = lockedAccountNames(accounts);
    if (locked.length) {
      throw new BadRequestException(
        `${locked.join(", ")} ${locked.length === 1 ? "is" : "are"} locked — deselect ${locked.length === 1 ? "it" : "them"} to continue.`,
      );
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

  // POST /api/posts/failures/clear — tidy the Error tab.
  //
  // Clearing HIDES failures from the default feed. It deletes NOTHING: the
  // target row, its last_error, the post, its analytics and its history are all
  // untouched, `restore: true` puts them straight back, and a cleared failure
  // that is later re-sent still publishes normally. The only thing that changes
  // is whether the row shows up without ?includeCleared=1.
  //
  // Gated to admin/Group Head, matching page locking in accounts.service: the
  // Error tab is shared workspace state, so one person tidying it changes what
  // everyone else sees, and that is a policy decision rather than a personal
  // view preference.
  //
  // `all` clears the whole window rather than a list. It exists because the
  // realistic case is "Postiz was down for four minutes and left 200 rows", and
  // making someone tick 200 boxes would push them toward deleting the posts
  // instead — which is the destructive thing this feature is meant to prevent.
  async clearFailures(payload: any, me: any) {
    if (!me || (me.role !== "admin" && !me.is_group_head)) {
      throw new ForbiddenException("Only an admin or Group Head can clear the error list.");
    }

    const supabase = this.supabaseService.createServiceClient();
    const { targetIds, postIds, all, days, restore } = payload || {};
    const undo = restore === true || restore === "true";

    const window = Math.min(Math.max(Number(days) || FAILURE_WINDOW_DAYS, 1), 365);
    const since = new Date(Date.now() - window * 86400000).toISOString();

    const patch = undo
      ? { failure_cleared_at: null, failure_cleared_by: null }
      : { failure_cleared_at: new Date().toISOString(), failure_cleared_by: me?.id || null };

    const wantTargets = Array.isArray(targetIds) ? targetIds.filter(Boolean) : [];
    const wantPosts = Array.isArray(postIds) ? postIds.filter(Boolean) : [];
    if (!all && !wantTargets.length && !wantPosts.length) {
      throw new BadRequestException("Nothing selected — pass targetIds, postIds, or all: true.");
    }

    let targetCount = 0;
    let postCount = 0;

    if (all) {
      // Scoped to the same window the feed is showing, so "clear all" can only
      // ever affect rows the person could actually see.
      let tq = supabase.from("post_targets").update(patch).eq("status", "failed").gte("created_at", since);
      tq = undo ? tq.not("failure_cleared_at", "is", null) : tq.is("failure_cleared_at", null);
      const { data: tRows, error: tErr } = await tq;
      if (tErr) throw new InternalServerErrorException(tErr.message);
      targetCount = (tRows || []).length;

      let pq = supabase
        .from("scheduled_posts")
        .update(patch)
        .eq("user_id", OWNER_ID)
        .eq("status", "failed")
        .gte("scheduled_for", since);
      pq = undo ? pq.not("failure_cleared_at", "is", null) : pq.is("failure_cleared_at", null);
      const { data: pRows, error: pErr } = await pq;
      if (pErr) throw new InternalServerErrorException(pErr.message);
      postCount = (pRows || []).length;
    } else {
      if (wantTargets.length) {
        const { data, error } = await supabase
          .from("post_targets")
          .update(patch)
          .in("id", wantTargets)
          .eq("status", "failed");
        if (error) throw new InternalServerErrorException(error.message);
        targetCount = (data || []).length;
      }
      if (wantPosts.length) {
        const { data, error } = await supabase
          .from("scheduled_posts")
          .update(patch)
          .in("id", wantPosts)
          .eq("user_id", OWNER_ID)
          .eq("status", "failed");
        if (error) throw new InternalServerErrorException(error.message);
        postCount = (data || []).length;
      }
    }

    const affected = targetCount + postCount;
    await logActivity({
      type: undo ? "post.failures_restored" : "post.failures_cleared",
      title: undo ? `Restored ${affected} cleared failure(s)` : `Cleared ${affected} failure(s) from the error list`,
      status: "info",
      meta: { by: me?.id || null, all: !!all, days: window, targets: targetCount, posts: postCount },
    });

    return { ok: true, affected, targets: targetCount, posts: postCount, restored: undo };
  }

  // POST /api/posts/retry — re-send the FAILED targets of an existing post.
  //
  // Retry in place rather than cloning: the post keeps its id, its approval
  // history, its author and its analytics linkage, and the pages that already
  // published are untouched. /api/posts/recycle is the other tool — that one
  // deliberately makes a NEW post for ALL pages.
  //
  // Nothing here talks to a platform. Eligible targets are reset to
  // "scheduled" and handed to PublisherService, the same code /api/cron/publish
  // runs — which is why this covers Postiz-backed channels (Threads, standalone
  // Instagram, X), Instagram, YouTube and Facebook posts/Reels/Stories without
  // knowing anything about them.
  //
  // `scheduledFor` omitted = send now. Given a time, the targets go back on the
  // queue and the normal cron run picks them up.
  async retry(payload: any, author: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { postId, targetIds, scheduledFor, body, linkUrl } = payload || {};
    if (!postId) throw new BadRequestException("postId is required.");

    let when: Date | null = null;
    if (scheduledFor) {
      when = new Date(scheduledFor);
      if (Number.isNaN(when.getTime())) throw new BadRequestException("Invalid schedule time.");
    }

    // An optional edit applied to this re-send: the caption, the link, or both.
    // Same emptiness rule as update() — a blank caption is a mistake, not an
    // instruction — and `linkUrl: null` is an explicit "drop the link", which is
    // why the two are tracked by presence rather than truthiness.
    const editsBody = body !== undefined;
    const editsLink = linkUrl !== undefined;
    if (editsBody && (typeof body !== "string" || !body.trim())) {
      throw new BadRequestException("Caption can't be empty.");
    }
    const newBody = editsBody ? body.trim() : null;
    const newLink = editsLink ? (linkUrl || null) : null;

    const { data: post, error } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(*))")
      .eq("id", postId)
      .eq("user_id", OWNER_ID)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!post) throw new NotFoundException("Post not found.");

    // An explicit target list narrows the retry to those pages; without one,
    // every failed page on the post is retried.
    const wanted = Array.isArray(targetIds) && targetIds.length ? new Set(targetIds) : null;
    const candidates = (post.post_targets || []).filter(
      (t: any) => t.status === "failed" && (!wanted || wanted.has(t.id)),
    );

    if (!candidates.length) {
      throw new BadRequestException(
        wanted ? "None of the selected pages are in a failed state." : "This post has no failed pages to retry.",
      );
    }

    const eligible: any[] = [];
    const skipped: any[] = [];
    const name = (t: any) => t.social_accounts?.display_name || "Unknown channel";

    for (const target of candidates) {
      const account = target.social_accounts;

      // THE double-post guard. A target holding an external_post_id reached the
      // platform and got an id back, so whatever failed afterwards (the first
      // comment, a status write) happened AFTER the post was live. Re-sending
      // would publish it twice, and a duplicate on a live page cannot be taken
      // back. These need /api/posts/verify, not a retry.
      //
      // The one exception is a target we have since CONFIRMED never published —
      // Postiz reporting the post's state as ERROR, recorded as
      // publish_rejected_at. There the id exists but nothing is live behind it,
      // so re-sending creates no duplicate. Note this reads the recorded fact,
      // never the error text: "rejected" in a message proves nothing.
      if (target.external_post_id && !target.publish_rejected_at) {
        skipped.push({
          targetId: target.id,
          channel: name(target),
          reason: "Already reached the platform — it has a post id. Check the page and verify instead of re-sending.",
        });
        continue;
      }

      if (!account) {
        skipped.push({ targetId: target.id, channel: name(target), reason: "Its channel is no longer connected." });
        continue;
      }

      if (isLocked(account)) {
        skipped.push({ targetId: target.id, channel: name(target), reason: "This page is locked for posting." });
        continue;
      }

      // Same check the publisher would run, applied HERE so an unpublishable
      // account is reported as a skip with its real reason instead of being
      // queued and failing again a moment later with the same error.
      try {
        assertPublishable(account);
      } catch (e) {
        skipped.push({ targetId: target.id, channel: name(target), reason: e.message });
        continue;
      }

      eligible.push(target);
    }

    if (!eligible.length) {
      return { ok: false, retried: 0, published: 0, failed: 0, skipped, queued: false };
    }

    // Back onto the queue. last_error and sent_at are cleared so a target that
    // fails again carries the NEW reason, not a stale one.
    const eligibleIds = eligible.map((t: any) => t.id);
    const reset: any = { status: "scheduled", last_error: null, sent_at: null };

    // Any confirmed-rejected target among these is losing its dead id here, so
    // record it before it goes — the activity entry below is then the only
    // place that still names it.
    const discardedIds = eligible
      .filter((t: any) => t.external_post_id && t.publish_rejected_at)
      .map((t: any) => ({ targetId: t.id, externalPostId: t.external_post_id }));

    // Does anything this post produced still stand? Targets being re-sent are
    // excluded: a confirmed rejection carries an external_post_id that is
    // precisely NOT live, and counting it here would make every rejection look
    // like a partial success.
    const retrying = new Set(eligibleIds);
    const somethingLive = (post.post_targets || []).some(
      (t: any) => !retrying.has(t.id) && (t.status === "sent" || !!t.external_post_id),
    );

    if (editsBody || editsLink) {
      if (somethingLive) {
        // Other pages already published this post, so its body is the record of
        // what THEY are showing. The edit rides on the target instead — see
        // PostTarget.content_override.
        const override: any = {};
        if (editsBody) override.body = newBody;
        if (editsLink) override.linkUrl = newLink;
        reset.content_override = override;
      } else {
        // Nothing published anywhere, so the post itself is the truth and can
        // simply be edited. Any override from an earlier attempt is dropped so
        // it cannot shadow the caption the user just wrote.
        const postEdit: any = {};
        if (editsBody) postEdit.body = newBody;
        if (editsLink) postEdit.link_url = newLink;
        const { error: editError } = await supabase
          .from("scheduled_posts")
          .update(postEdit)
          .eq("id", post.id)
          .eq("user_id", OWNER_ID);
        if (editError) throw new InternalServerErrorException(editError.message);
        Object.assign(post, postEdit);
        reset.content_override = null;
      }
    }

    if (discardedIds.length) {
      // A rejected target keeps its (dead) external_post_id until it is
      // actually re-sent. Clearing it here is not tidiness: the double-post
      // guard and the cron's ready-target query both treat a present id as
      // "already on the platform", so a scheduled re-send would never be picked
      // up and a second Re-send would be refused. The permalink goes with it —
      // it points at nothing. Written for every eligible row rather than just
      // the rejected ones, which is a no-op for the rest: they only got past
      // the guard above by having no id, and a permalink never exists without
      // one.
      reset.external_post_id = null;
      reset.permalink = null;
      reset.publish_rejected_at = null;
    }

    const { error: resetError } = await supabase.from("post_targets").update(reset).in("id", eligibleIds);
    if (resetError) throw new InternalServerErrorException(resetError.message);

    const sendNow = !when;
    await supabase
      .from("scheduled_posts")
      .update({
        scheduled_for: (when || new Date()).toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", post.id)
      .eq("user_id", OWNER_ID);

    // Let the shared rule decide the post's status rather than forcing
    // "scheduled": a post can have pages still awaiting review alongside the
    // failed ones, and hard-coding a status here would overwrite that and drop
    // the post out of the review queue.
    await this.publisher.refreshPostStatus(supabase, post.id);

    // What this retry changed, beyond the targets it touched. Both belong in
    // the record: an edited re-send published something different from what the
    // post said a moment ago, and a discarded id is a reference no row holds
    // any more.
    const retryMeta = {
      postId: post.id,
      targetIds: eligibleIds,
      by: author?.id || null,
      ...(editsBody || editsLink
        ? { edited: { ...(editsBody ? { body: newBody } : {}), ...(editsLink ? { linkUrl: newLink } : {}) }, editScope: somethingLive ? "target" : "post" }
        : {}),
      ...(discardedIds.length ? { discardedRejectedIds: discardedIds } : {}),
    };

    if (!sendNow) {
      await logActivity({
        type: "post.retried",
        title: `Requeued ${eligible.length} failed page(s) for ${when.toLocaleString()}`,
        status: "info",
        meta: retryMeta,
      });
      return { ok: true, retried: eligible.length, published: 0, failed: 0, skipped, queued: true };
    }

    // Send now — run the queue publisher against just these targets. Scoped to
    // this post on purpose: a retry button must not drag every other due post
    // into the same request. The rows carry `reset`, so the publisher sees the
    // same per-page override that was just written rather than the stale one it
    // was read with.
    const fresh = eligible.map((t: any) => ({ ...t, ...reset }));
    const { published, failed } = await this.publisher.publishTargets(supabase, post, fresh, { context: "retry" });
    await this.publisher.refreshPostStatus(supabase, post.id);

    await logActivity({
      type: "post.retried",
      title: failed
        ? `Retried ${eligible.length} failed page(s) — ${published} sent, ${failed} failed again`
        : `Retried ${eligible.length} failed page(s) — all sent`,
      status: failed ? (published ? "warning" : "error") : "success",
      meta: retryMeta,
    });

    return { ok: true, retried: eligible.length, published, failed, skipped, queued: false };
  }

  // POST /api/posts/recycle — clone a post back into the queue.
  async recycle(payload: any, author: any) {
    const supabase = this.supabaseService.createServiceClient();

    const { postId, scheduledFor } = payload || {};
    if (!postId) throw new BadRequestException("postId is required.");

    const { data: post, error } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(social_account_id, platform, social_accounts(id, display_name, posting_locked))")
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

    // Drop targets whose page has since been locked. Copying them would queue
    // a post that can only fail at send time, and the original post predates
    // the lock — so the honest clone is the un-locked subset.
    const liveTargets = (post.post_targets || []).filter((t: any) => !isLocked(t.social_accounts));
    const skipped = (post.post_targets || []).length - liveTargets.length;
    if (!liveTargets.length) {
      await supabase.from("scheduled_posts").delete().eq("id", clone.id);
      throw new BadRequestException("Every page on that post is locked — nothing to recycle.");
    }

    const targets = liveTargets.map((t: any) => ({
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
      title: skipped
        ? `Recycled a post for ${when.toLocaleString()} — skipped ${skipped} locked page(s)`
        : `Recycled a post for ${when.toLocaleString()}`,
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
      .select("id, platform, display_name, posting_locked")
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
        // "all" means every page we can actually post to — locked pages are
        // silently out, exactly as they are for the composer's "Select all".
        targets = (accounts || []).filter((a: any) => !isLocked(a));
      } else {
        targets = [];
        const misses: string[] = [];
        const locked: string[] = [];
        for (const name of pagesField.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
          const acct: any = byName.get(name.toLowerCase());
          if (!acct) misses.push(name);
          else if (isLocked(acct)) locked.push(acct.display_name);
          else targets.push(acct);
        }
        if (misses.length) {
          errors.push({ row: rowNum, error: `Unknown page(s): ${misses.join(", ")}` });
          continue;
        }
        // Named explicitly, so say so rather than quietly dropping it — the
        // importer asked for this page by name.
        if (locked.length) {
          errors.push({ row: rowNum, error: `Locked page(s): ${locked.join(", ")} — unlock or remove them.` });
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
          checked++;
          const recon = await reconcilePostizTarget(target);
          // A Postiz-side ERROR is a real, newly-discovered failure: push the
          // new status so the roll-up below sees it, rather than the "sent" the
          // target has been carrying since Postiz returned 201.
          targetStatuses.push(recon.failed ? "failed" : target.status);
          if (recon.failed) postChanged = true;
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
      else if (targetStatuses.every((s) => s === "failed" || s === "deleted")) newStatus = "failed";
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
