import { Injectable, InternalServerErrorException, UnauthorizedException } from "@nestjs/common";
import { createHash } from "crypto";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { publishFacebookPost, publishFacebookReel, publishFacebookStory, postFacebookComment, checkFacebookPostStatus, getFacebookPostMetrics } from "../../lib/facebook";
import { publishInstagramPost, postInstagramComment, checkInstagramPostStatus, getInstagramPostMetrics } from "../../lib/instagram";
import { publishPostizPost, reconcilePostizTarget, getPostizPostMetrics } from "../../lib/postiz";
import { publishYouTubeVideo, checkYouTubeVideoStatus, getYouTubeVideoAnalytics } from "../../lib/youtube";
import { logActivity } from "../../lib/activity";
import { appendUtm, utmTrackingEnabled } from "../../lib/utm";
import { assertPublishable, postForPlatform, platformOptions, fbFormat } from "../../lib/postContent";
import { buildPostInsightRow } from "../../lib/postInsightRow";
import { noteAccountPublishFailure, clearAccountPublishFailure } from "../../lib/accountHealth";
import { ApprovalsService } from "../approvals/approvals.service";
import { SocialSyncService } from "../insights/social-sync.service";

// How many due posts one publish run will work through. Raised 25 → 50 on
// 2026-08-21 at the team's request, now that the queue-starvation fix means the
// budget is only ever spent on posts that can actually publish.
//
// This is NOT the binding constraint for postiz-backed accounts. Postiz caps
// create-post at roughly 100 calls/hour for the WHOLE workspace, and this cron
// runs every 5 minutes — so 50 posts/run is already far above what Postiz will
// accept in an hour. The limit here only bounds how much work one run attempts;
// see the 429 note in HANDOFF §5 before raising it further.
const PUBLISH_BATCH_SIZE = 50;

// Cap on the target lookup that decides WHICH posts have publishable work.
// Purely a runaway guard — a queue of this many unpublished targets is its own
// incident, not something to page through.
const READY_TARGET_SCAN = 5000;

@Injectable()
export class CronService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly approvals: ApprovalsService,
    private readonly socialSync: SocialSyncService,
  ) {}

  // Auto-approve pending_review posts whose auto_approve_at has elapsed.
  async autoApprove(req: any) {
    this.authorize(req);
    return this.approvals.autoApproveDue();
  }

  // Sync ALL posts (organic + app-made) from connected FB/IG pages into
  // social_posts. Runs on the CRON_SECRET, so no user session — passes me=null.
  async syncPosts(req: any) {
    this.authorize(req);
    const days = Math.min(Math.max(Number(req.query?.days) || 90, 1), 365);
    return this.socialSync.sync(null, { days });
  }

  // Cron endpoints authenticate with a shared CRON_SECRET (Bearer header or
  // ?secret=), NOT a user session.
  private authorize(req: any) {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new UnauthorizedException("Unauthorized.");
    const header = req.headers?.authorization || "";
    const querySecret = req.query?.secret;
    if (header === `Bearer ${secret}` || querySecret === secret) return;
    throw new UnauthorizedException("Unauthorized.");
  }

  // Queue publisher — publishes due targets the FB native scheduler isn't handling.
  async publish(req: any) {
    this.authorize(req);
    const supabase = this.supabaseService.createServiceClient();

    // Which posts actually have work? Ask the TARGETS first.
    //
    // This used to select straight from scheduled_posts with `status in
    // (scheduled, pending_review)`, oldest-first, limit 25 — and that starved
    // the queue. `pending_review` is included on purpose (per-page approval
    // means one page can be approved and due while another still awaits
    // review), but such a post usually has NO publishable target, so it
    // contributes nothing while still consuming a slot. A backlog of 25+ old
    // unreviewed posts therefore filled the entire page, and every genuinely-due
    // post newer than them was never fetched — silently, with no error, for as
    // long as the backlog sat there. Asking the targets first makes the limit
    // below mean "PUBLISH_BATCH_SIZE posts we can actually publish".
    //
    // No ORDER BY here on purpose: post_targets has no schedule column, so any
    // ordering (created_at included) would imply a priority it doesn't carry —
    // due-ness is decided by scheduled_for in the second query. The cap is only
    // a runaway guard (READY_TARGET_SCAN).
    const { data: readyTargets, error: readyError } = await supabase
      .from("post_targets")
      .select("post_id")
      .eq("status", "scheduled")
      .is("external_post_id", null)
      .limit(READY_TARGET_SCAN);
    if (readyError) throw new InternalServerErrorException(readyError.message);

    const readyPostIds = [...new Set((readyTargets || []).map((t: any) => t.post_id).filter(Boolean))];
    if (!readyPostIds.length) return { due: 0, published: 0, failed: 0 };

    // Recover posts orphaned mid-run. The loop below flips a post to
    // "publishing" BEFORE working through its targets, and that flip doubles as
    // the lock stopping the next cron run from touching the same post. If the
    // process dies in between — a container rebuild, say — the post is stranded:
    // "publishing" isn't in the status filter below, so it would never be
    // retried. Two hours is far longer than any real run (every platform call
    // has its own timeout in the low minutes), so anything still "publishing"
    // by then is dead and safe to requeue. Scoped to readyPostIds so a post
    // whose targets all published is left alone rather than being dragged back
    // to "scheduled" and displaying the wrong status forever.
    const staleCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: revived } = await supabase
      .from("scheduled_posts")
      .update({ status: "scheduled" })
      .eq("user_id", OWNER_ID)
      .eq("status", "publishing")
      .in("id", readyPostIds)
      .lt("updated_at", staleCutoff);
    if (revived?.length) {
      console.warn(`[cron] requeued ${revived.length} post(s) stranded in "publishing".`);
    }

    const { data: due, error } = await supabase
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(*))")
      .eq("user_id", OWNER_ID)
      .in("id", readyPostIds)
      .in("status", ["scheduled", "pending_review"])
      .lte("scheduled_for", new Date().toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(PUBLISH_BATCH_SIZE);
    if (error) throw new InternalServerErrorException(error.message);

    let published = 0,
      failed = 0;
    const utmOn = await utmTrackingEnabled();

    for (const post of due || []) {
      if (utmOn && post.link_url) {
        const tagged = appendUtm(post.link_url, { postId: post.id });
        if (tagged !== post.link_url) {
          post.link_url = tagged;
          await supabase.from("scheduled_posts").update({ link_url: tagged }).eq("id", post.id);
        }
      }
      const queued = (post.post_targets || []).filter(
        (t) => t.status === "scheduled" && !t.external_post_id && t.social_accounts,
      );
      if (!queued.length) continue;

      // Stamp updated_at explicitly: the pg shim issues raw UPDATEs, and
      // TypeORM's @UpdateDateColumn only fires through the repository API, so
      // Postgres would leave it at insert time. The stale-recovery above reads
      // this column to tell a live run from a dead one — without the stamp it
      // would either never recover anything or recover a run still in flight.
      await supabase
        .from("scheduled_posts")
        .update({ status: "publishing", updated_at: new Date().toISOString() })
        .eq("id", post.id);

      for (const target of queued) {
        const account: any = target.social_accounts;
        try {
          assertPublishable(account);
          // Per-platform caption override (falls back to the master body).
          const postData = postForPlatform(post, account.platform);
          const result =
            // Threads / standalone Instagram / X relay through Postiz. Tested
            // first: the account keeps its real platform value, so it would
            // otherwise fall into a native branch. Postiz has no add-comment
            // endpoint, so the first comment travels with the post.
            account.publish_via === "postiz"
              ? await publishPostizPost({
                  account,
                  post: postData,
                  options: platformOptions(post, account.platform),
                  firstComment: post.first_comment || "",
                })
              : account.platform === "instagram"
                ? await publishInstagramPost({ account, post: postData })
                : account.platform === "youtube"
                  ? await publishYouTubeVideo({ account, post: postData, options: platformOptions(post, "youtube") } as any)
                  : fbFormat(post) === "reel"
                    ? await publishFacebookReel({ account, post: postData })
                    : fbFormat(post) === "story"
                      ? await publishFacebookStory({ account, post: postData })
                      : await publishFacebookPost({ account, post: postData });

          await supabase
            .from("post_targets")
            .update({
              status: "sent",
              external_post_id: result.externalPostId,
              sent_at: new Date().toISOString(),
              last_error: null,
            })
            .eq("id", target.id);
          published++;
          // A publish proves the token still works — lift any earlier flag.
          await clearAccountPublishFailure(account);

          // Stories have no comments — skip the first comment for them. Postiz
          // already submitted it with the post, so skip those too.
          const isStory = account.platform === "facebook" && fbFormat(post) === "story";
          if (!isStory && !result.firstCommentIncluded && post.first_comment?.trim() && result.externalPostId) {
            try {
              if (account.platform === "instagram") {
                await postInstagramComment({ account, mediaId: result.externalPostId, message: post.first_comment });
              } else if (account.platform === "facebook") {
                await postFacebookComment({ account, postId: result.externalPostId, message: post.first_comment });
              }
            } catch (e) {
              console.warn(`[cron] first comment failed for ${account.display_name}:`, e.message);
            }
          }
        } catch (err) {
          await supabase.from("post_targets").update({ status: "failed", last_error: err.message }).eq("id", target.id);
          failed++;
          // Token/permission/restriction failures are about the page, not this
          // post — mark it so the UI says "reconnect" instead of failing every
          // future post to it with the same opaque message.
          await noteAccountPublishFailure(account, err.message);
          await logActivity({
            type: "post.failed",
            title: `Queued post failed on ${account.display_name}`,
            status: "error",
            meta: { postId: post.id, error: err.message },
          });
        }
      }

      const { data: fresh } = await supabase.from("post_targets").select("status").eq("post_id", post.id);
      const statuses = (fresh || []).map((t) => t.status);
      // Keep the post in review while any page still awaits approval — only the
      // approved pages just published above; the rest stay pending.
      const newStatus = statuses.includes("pending_review")
        ? "pending_review"
        : statuses.some((s) => s === "sent" || s === "scheduled")
          ? statuses.includes("scheduled")
            ? "scheduled"
            : "sent"
          : "failed";
      await supabase
        .from("scheduled_posts")
        .update({ status: newStatus, sent_at: newStatus === "sent" ? new Date().toISOString() : null })
        .eq("id", post.id);

      if (newStatus === "sent") {
        await logActivity({
          type: "post.published",
          title: `Queued post published (${queued.length} target(s))`,
          status: "success",
          meta: { postId: post.id },
        });
      }
    }

    return { due: (due || []).length, published, failed };
  }

  // Verify recent sent posts still exist on-platform.
  async verifyPosts(req: any) {
    this.authorize(req);
    const supabase = this.supabaseService.createServiceClient();

    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const { data: posts, error } = await supabase
      .from("scheduled_posts")
      .select(
        "id, body, link_url, status, sent_at, post_targets(id, status, external_post_id, last_verified_at, remote_message_hash, social_accounts(id, display_name, access_token, refresh_token, platform, external_account_id))",
      )
      .eq("user_id", OWNER_ID)
      .in("status", ["sent", "publishing"])
      .gte("sent_at", twentyFourHoursAgo)
      .order("sent_at", { ascending: false });

    if (error) throw new InternalServerErrorException(error.message);

    let checked = 0,
      deleted = 0,
      errors = 0;

    for (const post of posts || []) {
      let postChanged = false;
      const targetStatuses: string[] = [];

      for (const target of post.post_targets || []) {
        const account: any = target.social_accounts;

        if (!target.external_post_id || target.external_post_id.includes("_mock_") || !account) {
          targetStatuses.push(target.status);
          continue;
        }
        // Reels/Stories are exempt from existence checks: stories expire after
        // 24h (a 404 is NOT a deletion) and reel ids need a different lookup.
        // Detect them by the declared format OR by the id shape — feed posts are
        // "{pageId}_{postId}", while reels/videos/stories carry a bare numeric
        // id. Querying is_published/message on a bare id returns code 10/100,
        // which the existence check mistakes for a deletion, so a live reel gets
        // wrongly marked "deleted on platform".
        if (
          account.platform === "facebook" &&
          (fbFormat(post) !== "post" || !String(target.external_post_id).includes("_"))
        ) {
          targetStatuses.push(target.status);
          continue;
        }
        if (target.status === "deleted") {
          targetStatuses.push("deleted");
          continue;
        }
        if (target.last_verified_at) {
          const lastCheck = new Date(target.last_verified_at).getTime();
          if (now.getTime() - lastCheck < 3 * 60 * 60 * 1000) {
            targetStatuses.push(target.status);
            continue;
          }
        }

        // Postiz-backed targets (Threads / personal Instagram) reconcile against
        // Postiz instead: it reports a publish error and hands back a permalink,
        // but has no trustworthy signal that a post was removed on the platform.
        // Marking them deleted off a missing Postiz record would invent
        // deletions, so they stay exempt from deletion sync.
        if (account.publish_via === "postiz") {
          checked++;
          await reconcilePostizTarget(target);
          targetStatuses.push(target.status);
          continue;
        }

        checked++;
        let result;
        try {
          if (account.platform === "facebook") {
            result = await checkFacebookPostStatus({ account, externalPostId: target.external_post_id });
          } else if (account.platform === "instagram") {
            result = await checkInstagramPostStatus({ account, externalPostId: target.external_post_id });
          } else if (account.platform === "youtube") {
            result = await checkYouTubeVideoStatus({ account, videoId: target.external_post_id });
          } else {
            targetStatuses.push(target.status);
            continue;
          }
        } catch (err) {
          result = { exists: null, error: err.message };
        }

        await supabase.from("post_targets").update({ last_verified_at: now.toISOString() }).eq("id", target.id);

        if (result.exists === false) {
          const platformName =
            ({ youtube: "YouTube", facebook: "Facebook", threads: "Threads", twitter: "X", instagram: "Instagram" } as any)[
              account.platform
            ] || account.platform;

          const { error: updateError } = await supabase
            .from("post_targets")
            .update({
              status: "deleted",
              last_error: `This ${account.platform === "youtube" ? "video" : "post"} was deleted on ${platformName}.`,
              deleted_at: now.toISOString(),
            })
            .eq("id", target.id);

          if (updateError) {
            console.error("[verify-posts] couldn't mark target deleted:", updateError.message);
            errors++;
            targetStatuses.push(target.status);
            continue;
          }

          targetStatuses.push("deleted");
          deleted++;
          postChanged = true;

          await logActivity({
            type: "post.deleted",
            title: `${platformName} ${account.platform === "youtube" ? "video" : "post"} deleted — ${account.display_name}`,
            status: "warning",
            meta: {
              postId: post.id,
              page: account.display_name,
              platform: account.platform,
              preview: post.body.slice(0, 80),
            },
          });
        } else if (result.exists === true) {
          // ── External-edit pull (Facebook only — IG/Threads don't allow edits).
          // remote_message_hash remembers the last remote caption we saw, so a
          // caption edited directly on Facebook is detected exactly once.
          if (account.platform === "facebook" && typeof (result as any).remoteMessage === "string") {
            const remote = (result as any).remoteMessage.trim();
            const hash = createHash("sha1").update(remote).digest("hex");
            if (hash !== target.remote_message_hash) {
              await supabase.from("post_targets").update({ remote_message_hash: hash }).eq("id", target.id);
              // Our own link-folding appends link_url to the caption — don't
              // treat that difference as an external edit.
              const localBody = (post.body || "").trim();
              const localWithLink = post.link_url ? `${localBody}\n\n${post.link_url.trim()}` : localBody;
              if (remote && remote !== localBody && remote !== localWithLink) {
                if ((post.post_targets || []).length === 1) {
                  // Single-target post: the remote caption is authoritative — pull it in.
                  await supabase.from("scheduled_posts").update({ body: remote }).eq("id", post.id);
                  await logActivity({
                    type: "post.edited_external",
                    title: `Caption edited on Facebook — synced into the app (${account.display_name})`,
                    status: "info",
                    meta: { postId: post.id, page: account.display_name },
                  });
                } else {
                  // Multi-target post: don't clobber the shared caption — notify instead.
                  await logActivity({
                    type: "post.edited_external",
                    title: `Caption edited on Facebook — ${account.display_name} now differs from the app copy`,
                    status: "warning",
                    meta: { postId: post.id, page: account.display_name },
                  });
                }
              }
            }
          }
          targetStatuses.push(target.status);
        } else if (result.exists === null) {
          console.warn(`[verify-posts] couldn't verify status for ${account.display_name}:`, result.error);
          errors++;
          targetStatuses.push(target.status);
        }
      }

      if (!postChanged || !targetStatuses.length) continue;

      let newStatus = post.status;
      if (targetStatuses.every((s) => s === "deleted")) {
        newStatus = "deleted";
      }

      if (newStatus !== post.status) {
        await supabase.from("scheduled_posts").update({ status: newStatus }).eq("id", post.id);
      }
    }

    return { checked, deleted, errors, message: `Verified ${checked} posts/videos, found ${deleted} deleted.` };
  }

  // Insights sync + optional auto-recycle of the top performer.
  async insights(req: any) {
    this.authorize(req);
    const supabase = this.supabaseService.createServiceClient();
    const since = new Date(Date.now() - 30 * 86400000).toISOString();

    // No Threads token upkeep here any more: Threads publishes through Postiz,
    // which holds and refreshes that token itself. The block that used to
    // refresh expiring long-lived Threads tokens went away with the native
    // Threads path.
    const { data: targets, error } = await supabase
      .from("post_targets")
      .select(
        "id, external_post_id, platform, sent_at, social_accounts(id, display_name, access_token, platform, publish_via, external_account_id, metadata)",
      )
      .eq("status", "sent")
      .in("platform", ["facebook", "instagram", "threads", "twitter", "youtube"])
      .not("external_post_id", "is", null)
      .gte("sent_at", since)
      .order("sent_at", { ascending: false })
      .limit(150);
    if (error) throw new InternalServerErrorException(error.message);

    let synced = 0,
      failed = 0;

    for (const target of targets || []) {
      if (!target.social_accounts || target.external_post_id.includes("_mock_")) continue;
      try {
        const account: any = target.social_accounts;
        let m;
        if (account.publish_via === "postiz") {
          // Postiz reports analytics per ITS post id, not the platform's, and
          // the same call serves Threads and Instagram — so route on how the
          // account publishes rather than on the platform.
          m = await getPostizPostMetrics({ externalPostId: target.external_post_id });
        } else if (target.platform === "instagram") {
          m = await getInstagramPostMetrics({ account, externalPostId: target.external_post_id });
        } else if (target.platform === "youtube") {
          const yt = await getYouTubeVideoAnalytics({ account, videoId: target.external_post_id });
          m = { likes: yt.likes, comments: yt.comments, shares: 0, impressions: yt.views, reach: null, raw: yt.raw };
        } else {
          m = await getFacebookPostMetrics({ account, externalPostId: target.external_post_id });
        }
        await supabase.from("post_insights").delete().eq("post_target_id", target.id);
        await supabase.from("post_insights").insert(buildPostInsightRow(target, m));
        synced++;
      } catch (err) {
        failed++;
        console.warn(`[insights] sync failed for target ${target.id}:`, err.message);
      }
    }

    // ── Auto-recycle top performer (opt-in via Settings) ──
    let recycled: any = null;
    const { data: settingsRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("user_id", OWNER_ID)
      .eq("key", "app")
      .maybeSingle();
    const settings = settingsRow?.value || {};

    if (settings.autoRecycle) {
      const dayAhead = new Date(Date.now() + 86400000).toISOString();
      const { count: upcoming } = await supabase
        .from("scheduled_posts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", OWNER_ID)
        .eq("status", "scheduled")
        .lte("scheduled_for", dayAhead);

      if ((upcoming || 0) === 0) {
        const { data: insights } = await supabase
          .from("post_insights")
          .select("likes, comments, shares, post_targets(post_id)")
          .gte("fetched_at", since);
        const scores = new Map();
        for (const i of insights || []) {
          const postId = (i.post_targets as any)?.post_id;
          if (!postId) continue;
          scores.set(postId, (scores.get(postId) || 0) + (i.likes || 0) + (i.comments || 0) + (i.shares || 0));
        }
        const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);

        for (const [postId, score] of ranked) {
          const { data: post } = await supabase
            .from("scheduled_posts")
            .select("*, post_targets(social_account_id, platform)")
            .eq("id", postId)
            .maybeSingle();
          if (!post || post.status !== "sent") continue;

          const { data: dupe } = await supabase
            .from("scheduled_posts")
            .select("id")
            .eq("user_id", OWNER_ID)
            .eq("body", post.body)
            .neq("id", post.id)
            .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())
            .limit(1);
          if (dupe?.length) continue;

          const when = new Date(Date.now() + 86400000);
          when.setMinutes(0, 0, 0);
          const { data: clone, error: cloneError } = await supabase
            .from("scheduled_posts")
            .insert({
              user_id: OWNER_ID,
              body: post.body,
              image_url: post.image_url,
              link_url: post.link_url,
              first_comment: post.first_comment,
              scheduled_for: when.toISOString(),
              status: "scheduled",
            })
            .select()
            .single();
          if (cloneError) break;

          await supabase.from("post_targets").insert(
            (post.post_targets || []).map((t) => ({
              post_id: clone.id,
              social_account_id: t.social_account_id,
              platform: t.platform,
              status: "scheduled",
            })),
          );
          recycled = { postId: clone.id, score, scheduledFor: when.toISOString() };
          await logActivity({
            type: "post.recycled",
            title: `Auto-recycled top performer (${score} engagements) for ${when.toLocaleString()}`,
            status: "warning",
            meta: { sourcePostId: post.id, newPostId: clone.id },
          });
          break;
        }
      }
    }

    return { synced, failed, recycled };
  }
}
