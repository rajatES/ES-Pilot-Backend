import { Injectable, InternalServerErrorException, UnauthorizedException } from "@nestjs/common";
import { createHash } from "crypto";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { checkFacebookPostStatus, getFacebookPostMetrics } from "../../lib/facebook";
import { checkInstagramPostStatus, getInstagramPostMetrics } from "../../lib/instagram";
import { refreshInstagramToken } from "../../lib/instagramOAuth";
import {
  reconcilePostizTarget,
  getPostizPostMetrics,
  syncPostizChannelHealth,
  findPostizPostByContent,
} from "../../lib/postiz";
import { checkYouTubeVideoStatus, getYouTubeVideoAnalytics } from "../../lib/youtube";
import { logActivity } from "../../lib/activity";
import { appendUtm, utmTrackingEnabled } from "../../lib/utm";
import { isLocked, fbFormat, assertPublishable } from "../../lib/postContent";
import { buildPostInsightRow } from "../../lib/postInsightRow";
import { ApprovalsService } from "../approvals/approvals.service";
import { SocialSyncService } from "../insights/social-sync.service";
import { PublisherService, AUTO_RETRY_DELAY_MS } from "../publisher/publisher.service";

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

// How long a target may sit at "publishing" before it is treated as stranded.
// Two hours matches the post-level sweep below and is far beyond any real
// attempt (every platform call has its own timeout in the low minutes), so it
// can never race a publish that is still in flight.
const STRANDED_TARGET_MS = 2 * 60 * 60 * 1000;

// How long after the original failure an automatic retry stops being worth
// attempting. Past this the post is stale enough that re-publishing it without
// anyone looking is its own mistake, so it stays failed and visible instead.
const AUTO_RETRY_GIVE_UP_MS = 6 * 60 * 60 * 1000;

// Cap on the target lookup that decides WHICH posts have publishable work.
// Purely a runaway guard — a queue of this many unpublished targets is its own
// incident, not something to page through.
const READY_TARGET_SCAN = 5000;

// Refresh a direct-Instagram token once it is within this many days of its
// 60-day expiry. Wide on purpose: a refresh can only happen while the token is
// still valid, so the margin IS the retry budget — 50 days of daily attempts
// before an account is unrecoverable. Narrowing this trades that safety for
// nothing, since a refresh costs one HTTP call per account per day.
const REFRESH_WINDOW_DAYS = 50;

@Injectable()
export class CronService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly approvals: ApprovalsService,
    private readonly socialSync: SocialSyncService,
    private readonly publisher: PublisherService,
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

  // Keep direct-Instagram (Instagram Login) tokens alive.
  //
  // This exists because those tokens are the ONLY expiring credential in the
  // app that cannot be recovered without the user. Facebook Page tokens are
  // effectively permanent; YouTube has a refresh_token that works whenever we
  // ask; Postiz holds its own. An Instagram-Login token lasts 60 days and can
  // only be refreshed while it is STILL VALID and at least 24h old — once it
  // lapses there is no API call back, only a manual reconnect. So this runs
  // daily and refreshes anything inside REFRESH_WINDOW_DAYS, which gives ~50
  // consecutive failed days before an account is actually lost.
  //
  // Deliberately NOT part of accounts.sync(): sync is user-triggered and reports
  // health, while this must run unattended whether or not anyone opens the app.
  async refreshTokens(req: any) {
    this.authorize(req);
    const supabase = this.supabaseService.createServiceClient();

    const { data: accounts, error } = await supabase
      .from("social_accounts")
      .select("id, display_name, access_token, token_expires_at, metadata, publish_via, platform")
      .eq("user_id", OWNER_ID)
      .eq("platform", "instagram");
    if (error) throw new InternalServerErrorException(error.message);

    // Only Instagram-Login rows have a refreshable token. Postiz rows carry no
    // token of ours, and Facebook-Page-linked rows don't expire on this clock.
    const due = (accounts || []).filter((a: any) => {
      if (a.publish_via === "postiz") return false;
      if (a.metadata?.instagram?.login !== "instagram") return false;
      if (!a.access_token) return false;
      if (!a.token_expires_at) return true; // unknown expiry — refresh and find out
      const daysLeft = (new Date(a.token_expires_at).getTime() - Date.now()) / 86400000;
      return daysLeft <= REFRESH_WINDOW_DAYS;
    });

    const results: any[] = [];
    for (const a of due) {
      try {
        const { accessToken, expiresIn } = await refreshInstagramToken(a.access_token);
        const metadata = { ...(a.metadata || {}) };
        delete metadata.auth_error;
        metadata.instagram = { ...(metadata.instagram || {}), refreshed_at: new Date().toISOString() };

        await supabase
          .from("social_accounts")
          .update({
            access_token: accessToken,
            token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
            publishing_ok: true,
            metadata,
          })
          .eq("id", a.id);
        results.push({ id: a.id, name: a.display_name, ok: true, expiresIn });
      } catch (e) {
        // A failed refresh is NOT yet a failed account — there are weeks of
        // retries left in the window — so publishing_ok is left alone. What we
        // must not do is stay quiet about it, or the first anyone hears is a
        // dead account.
        await supabase
          .from("social_accounts")
          .update({
            metadata: {
              ...(a.metadata || {}),
              auth_error: { message: `Token refresh failed: ${e.message}`, at: new Date().toISOString() },
            },
          })
          .eq("id", a.id);
        results.push({ id: a.id, name: a.display_name, ok: false, error: e.message });
      }
    }

    const failed = results.filter((r) => !r.ok);
    if (results.length) {
      await logActivity({
        type: "account.synced",
        title: failed.length
          ? `Refreshed ${results.length - failed.length}/${results.length} Instagram token(s) — ${failed.length} failed`
          : `Refreshed ${results.length} Instagram token(s)`,
        status: failed.length ? "warning" : "info",
        meta: failed.length ? { failed: failed.map((f) => ({ name: f.name, error: f.error })) } : {},
      });
    }

    return { checked: (accounts || []).length, due: due.length, refreshed: results.length - failed.length, failed };
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

  // Recompute a post's status from its targets. Shared by the publish loop and
  // the stranded-target sweep so the two can't drift — they answer the same
  // question ("what is this post now?") and a second copy of this ternary would
  // be exactly the kind of drift that hides a status bug.
  private async refreshPostStatus(supabase: any, postId: string) {
    return this.publisher.refreshPostStatus(supabase, postId);
  }

  // See the call site in publish() for why these are failed rather than retried.
  private async sweepStrandedTargets(supabase: any) {
    const cutoff = new Date(Date.now() - STRANDED_TARGET_MS).toISOString();
    const { data: stranded, error } = await supabase
      .from("post_targets")
      .update({
        status: "failed",
        last_error:
          "Publishing was interrupted before this page reported back (usually a backend restart mid-publish). " +
          "It may or may not have reached the platform — check the page before reposting.",
      })
      .eq("status", "publishing")
      .is("external_post_id", null)
      .lt("created_at", cutoff);

    if (error || !stranded?.length) return 0;

    for (const postId of [...new Set(stranded.map((t: any) => t.post_id))]) {
      await this.refreshPostStatus(supabase, postId as string);
    }

    console.warn(`[cron] ${stranded.length} target(s) were stranded mid-publish and have been marked failed.`);
    await logActivity({
      type: "post.failed",
      title: `${stranded.length} post target(s) were stranded mid-publish`,
      status: "error",
      meta: {
        targetIds: stranded.map((t: any) => t.id),
        note: "Interrupted before the platform reported back — verify the page before reposting.",
      },
    });
    return stranded.length;
  }

  // Automatic re-send of deliveries lost to a Postiz outage.
  //
  // Scope is deliberately tiny: ONE failure class (Postiz's hosting not
  // answering — 5xx, unreachable, timeout), ONE target at a time, and only the
  // pages that actually failed. A post that fanned out to X, Instagram and
  // Threads and died only on Threads gets Threads retried and nothing else, so
  // the two channels that already published are never touched. The publisher
  // works per-target anyway; what is new is that nobody has to press the button.
  //
  // Eligibility is NOT re-derived from the error text here. The publisher
  // stamps auto_retry_at at failure time, where the error is in hand, and this
  // reads that stamp — one judgement, made once. See PostTarget.auto_retry_at.
  //
  // THE SAFETY PROBLEM, and why this is more than "call retry again":
  // a 502 from an edge proxy means Postiz did not RESPOND. It does not mean
  // Postiz did not RECEIVE. The create may have gone through and published
  // seconds after the proxy gave up, and a blind retry would put the same post
  // out twice on a live channel — across 56 Threads channels during an outage,
  // that is the worst thing this app could do unattended. So every retry asks
  // Postiz first whether the post is already there, and:
  //
  //   found     -> adopt the id, mark it sent. It published; we just never heard.
  //   not found -> safe to re-send.
  //   unknown   -> do NOTHING and try again next run. An unreachable Postiz is
  //                not evidence of absence, and treating it as such is exactly
  //                the reasoning that would double-post.
  private async retryPostizOutages(supabase: any) {
    const nowIso = new Date().toISOString();
    const { data: due, error } = await supabase
      .from("post_targets")
      .select("*, scheduled_posts(*), social_accounts(*)")
      .eq("status", "failed")
      .not("auto_retry_at", "is", null)
      .lte("auto_retry_at", nowIso)
      .limit(100);
    if (error || !due?.length) return { attempted: 0, published: 0, adopted: 0, deferred: 0 };

    let attempted = 0,
      published = 0,
      adopted = 0,
      deferred = 0;

    for (const target of due) {
      const post = target.scheduled_posts;
      const account = target.social_accounts;

      // Stand down permanently: the work is gone, the channel is gone, the page
      // is locked, or the account can't publish at all. Clearing the stamp is
      // what stops this row being reconsidered every five minutes forever.
      const giveUp = (reason: string) => {
        console.warn(`[cron] auto-retry abandoned for target ${target.id}: ${reason}`);
        return supabase.from("post_targets").update({ auto_retry_at: null }).eq("id", target.id);
      };

      if (!post || !account) {
        await giveUp(!post ? "its post no longer exists" : "its channel is no longer connected");
        continue;
      }
      // Belt and braces against the double-post guard's own rule: a target
      // holding an id reached the platform, whatever else went wrong.
      if (target.external_post_id) {
        await giveUp("it already carries a post id");
        continue;
      }
      if (Date.now() - new Date(target.auto_retry_at).getTime() > AUTO_RETRY_GIVE_UP_MS) {
        await giveUp("the failure is too old to re-send unattended");
        continue;
      }
      if (isLocked(account)) {
        await giveUp("the page is locked for posting");
        continue;
      }
      try {
        assertPublishable(account);
      } catch (e: any) {
        await giveUp(e.message);
        continue;
      }

      // Did it actually publish while Postiz was failing to answer?
      //
      // Anchored on the FAILURE, which auto_retry_at encodes exactly (it was
      // set to failure + AUTO_RETRY_DELAY_MS). created_at would be wrong here:
      // that is when the target row was made, which for a post scheduled days
      // ahead is nowhere near when the publish was attempted, and the lookup
      // window would miss the post entirely — reading "not published" for one
      // that was.
      const failedAt = new Date(new Date(target.auto_retry_at).getTime() - AUTO_RETRY_DELAY_MS);
      const existing = await findPostizPostByContent({
        integrationId: account.external_account_id,
        content: target.content_override?.body || post.body || "",
        around: failedAt,
      });

      if (existing.found === null) {
        // Inconclusive. Leave auto_retry_at exactly as it is so the next run
        // asks again; the give-up window above is what bounds the loop.
        deferred++;
        continue;
      }

      if (existing.found) {
        await supabase
          .from("post_targets")
          .update({
            status: "sent",
            external_post_id: existing.id,
            permalink: existing.permalink || null,
            sent_at: new Date().toISOString(),
            last_error: null,
            auto_retry_at: null,
          })
          .eq("id", target.id);
        await this.refreshPostStatus(supabase, post.id);
        adopted++;
        await logActivity({
          type: "post.published",
          title: `Recovered a post Postiz published but never confirmed — ${account.display_name}`,
          status: "warning",
          meta: {
            postId: post.id,
            targetId: target.id,
            externalPostId: existing.id,
            note: "The publish call failed with a Postiz outage error, but the post was live. Adopted instead of re-sent.",
          },
        });
        continue;
      }

      // Genuinely not published — re-send this one page.
      attempted++;
      await supabase
        .from("post_targets")
        .update({
          status: "scheduled",
          last_error: null,
          sent_at: null,
          auto_retry_at: null,
          auto_retry_count: (target.auto_retry_count || 0) + 1,
        })
        .eq("id", target.id);

      const fresh = [{ ...target, status: "scheduled", last_error: null, auto_retry_count: (target.auto_retry_count || 0) + 1 }];
      const counts = await this.publisher.publishTargets(supabase, post, fresh, { context: "auto-retry" });
      published += counts.published;
      await this.refreshPostStatus(supabase, post.id);

      await logActivity({
        type: counts.published ? "post.published" : "post.failed",
        title: counts.published
          ? `Auto-retry sent ${account.display_name} after a Postiz outage`
          : `Auto-retry failed again on ${account.display_name}`,
        status: counts.published ? "info" : "error",
        meta: { postId: post.id, targetId: target.id, attempt: (target.auto_retry_count || 0) + 1 },
      });
    }

    if (attempted || adopted || deferred) {
      console.log(
        `[cron] postiz auto-retry: ${published} sent, ${adopted} adopted, ${deferred} deferred (inconclusive).`,
      );
    }
    return { attempted, published, adopted, deferred };
  }

  // Queue publisher — publishes due targets the FB native scheduler isn't handling.
  async publish(req: any) {
    this.authorize(req);
    const supabase = this.supabaseService.createServiceClient();

    // Targets stranded mid-publish, swept BEFORE anything else so a stranded
    // target can't keep its post invisible for another run.
    //
    // publish-now and the composer's "publish now" insert a target as
    // "publishing" and flip it to sent/failed when the attempt finishes. A
    // process that dies in between — a deploy rebuild is the usual way — leaves
    // the target at "publishing" with no external_post_id, and NOTHING recovers
    // it: the ready-target query below only looks for "scheduled", and the
    // post-level stale sweep is scoped to posts that already own a ready
    // target, which this post by definition does not. So it sat there forever,
    // never published, never failed, with nothing in the UI to say so. That is
    // the "it was scheduled but it never went out and there's no error" report.
    //
    // Marked FAILED rather than requeued, deliberately: at the moment the
    // process died the platform may ALREADY have accepted the post, so a blind
    // retry risks double-posting to a live page. A visible failure lets a human
    // check the page and repost; a duplicate can't be taken back.
    await this.sweepStrandedTargets(supabase);

    // Before the queue: a target waiting on an automatic re-send is work that
    // is already overdue, and running it first means an outage recovery is not
    // stuck behind the batch cap below.
    const autoRetry = await this.retryPostizOutages(supabase);

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
    if (!readyPostIds.length) return { due: 0, published: 0, failed: 0, autoRetry };

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
      const ready = (post.post_targets || []).filter((t) => t.status === "scheduled" && !t.external_post_id);

      // A ready target whose channel row is gone used to be dropped by the
      // `t.social_accounts` filter and nothing else ever looked at it again:
      // it stayed "scheduled" forever, never published, never failed, and never
      // appeared in the Error tab — which reads failed targets. Eight of these
      // were sitting in production from 2026-08-05, on a post still showing as
      // scheduled. That is the exact silent-failure shape the Error tab exists
      // to prevent, so they are recorded as failures now. Same wording as
      // posts.service.retry()'s skip reason, because it is the same condition.
      const orphaned = ready.filter((t) => !t.social_accounts);
      if (orphaned.length) {
        await supabase
          .from("post_targets")
          .update({ status: "failed", last_error: "Its channel is no longer connected." })
          .in("id", orphaned.map((t: any) => t.id));
        await logActivity({
          type: "post.failed",
          title: `${orphaned.length} queued page(s) had no channel left to publish to`,
          status: "error",
          meta: {
            postId: post.id,
            targetIds: orphaned.map((t: any) => t.id),
            note: "The social account was deleted after the post was scheduled. Nothing was sent.",
          },
        });
      }

      const queued = ready.filter((t) => t.social_accounts);
      if (!queued.length) {
        // Still recompute: the orphans above just changed this post's outcome,
        // and leaving it at "scheduled" would keep claiming work is pending.
        if (orphaned.length) await this.refreshPostStatus(supabase, post.id);
        continue;
      }

      // Stamp updated_at explicitly: the pg shim issues raw UPDATEs, and
      // TypeORM's @UpdateDateColumn only fires through the repository API, so
      // Postgres would leave it at insert time. The stale-recovery above reads
      // this column to tell a live run from a dead one — without the stamp it
      // would either never recover anything or recover a run still in flight.
      await supabase
        .from("scheduled_posts")
        .update({ status: "publishing", updated_at: new Date().toISOString() })
        .eq("id", post.id);

      // Dispatch lives in PublisherService so /api/posts/retry runs the exact
      // same code — see the note there on why a second copy is dangerous.
      const counts = await this.publisher.publishTargets(supabase, post, queued, { context: "cron" });
      published += counts.published;
      failed += counts.failed;

      // Keep the post in review while any page still awaits approval — only the
      // approved pages just published above; the rest stay pending.
      const newStatus = await this.refreshPostStatus(supabase, post.id);

      if (newStatus === "sent") {
        await logActivity({
          type: "post.published",
          title: `Queued post published (${queued.length} target(s))`,
          status: "success",
          meta: { postId: post.id },
        });
      }
    }

    return { due: (due || []).length, published, failed, autoRetry };
  }

  // Verify recent sent posts still exist on-platform.
  async verifyPosts(req: any) {
    this.authorize(req);
    const supabase = this.supabaseService.createServiceClient();

    // Whole-channel health first: a channel disabled or removed in Postiz fails
    // EVERY post to it, and Postiz reports that per-post (it accepts the create
    // and fails later), so without this the per-target loop below would rediscover
    // the same dead channel one post at a time and never name the actual cause.
    // One GET for the workspace, and it flips the same publishing_ok /
    // auth_error pair the Accounts UI already renders as "reconnect".
    const channelHealth = await syncPostizChannelHealth();

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
          const recon = await reconcilePostizTarget(target);
          if (recon.failed) {
            // Postiz accepted this post and then the platform rejected it, so
            // the target has been showing as "sent" since publish time. Feed
            // the new status into the roll-up below instead of pushing the
            // stale one, or a post whose only target just failed would stay
            // "sent" and never reach the Error tab.
            targetStatuses.push("failed");
            postChanged = true;
          } else {
            if (!recon.conclusive) errors++;
            targetStatuses.push(target.status);
          }
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
      } else if (targetStatuses.every((s) => s === "failed" || s === "deleted")) {
        // Nothing survived. Only reachable now that the Postiz branch above can
        // turn a "sent" target into a failed one hours after publish; a mixed
        // post is left alone on purpose, because it really did publish
        // somewhere and the per-target status carries the rest.
        newStatus = "failed";
      }

      if (newStatus !== post.status) {
        await supabase.from("scheduled_posts").update({ status: newStatus }).eq("id", post.id);
      }
    }

    return {
      checked,
      deleted,
      errors,
      postizChannels: channelHealth,
      message: `Verified ${checked} posts/videos, found ${deleted} deleted.`,
    };
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
            .select("*, post_targets(social_account_id, platform, social_accounts(id, display_name, posting_locked))")
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

          // A page locked since the original post went out must not be
          // re-targeted by the unattended recycler. Resolved BEFORE the clone
          // is written, so an all-locked post is skipped for the next-ranked
          // one instead of leaving behind an empty scheduled_posts row.
          const liveTargets = (post.post_targets || []).filter((t: any) => !isLocked(t.social_accounts));
          if (!liveTargets.length) continue;

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
            liveTargets.map((t: any) => ({
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
