import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
// @ts-ignore - plain JS platform clients (shared with the cron insights job).
import { getFacebookPostMetrics } from "../../lib/facebook";
// @ts-ignore
import { getInstagramPostMetrics } from "../../lib/instagram";
// @ts-ignore
import { getPostizPostMetrics } from "../../lib/postiz";
// @ts-ignore
import { getYouTubeVideoAnalytics } from "../../lib/youtube";
// @ts-ignore
import { buildPostInsightRow } from "../../lib/postInsightRow";

// Row cap on the Performance rollup. Presets can't exceed it at ES's volume,
// but a custom range can, so the response reports whether it was hit rather
// than handing back a total that silently stopped counting.
const LIST_LIMIT = 500;

// Per-post performance, built from the same platform metric APIs the insights
// cron already uses — fetched by external_post_id, never scraped.
@Injectable()
export class InsightsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // GET /api/insights?days=30, or ?start=YYYY-MM-DD&end=YYYY-MM-DD for an
  // explicit range — rollup of stored insights per sent post.
  async list(query: any = {}) {
    const supabase = this.supabaseService.createServiceClient();

    // A number is still accepted so nothing that called this with plain days
    // has to change.
    const q = typeof query === "object" && query !== null ? query : { days: query };
    const { sinceIso, untilIso, windowDays, start, end } = this.resolveRange(q, 90);

    let postQuery = supabase
      .from("scheduled_posts")
      .select(
        // permalink feeds the Performance list's "open the live post" link.
        // Without it a Threads/Instagram row can never be opened: their ids map
        // to no public URL, so the stored releaseURL is the only source.
        "id, body, image_url, link_url, media, content_type, sent_at, status, post_targets(id, platform, status, external_post_id, permalink, social_accounts(display_name, platform, category))",
      )
      .eq("user_id", OWNER_ID)
      .eq("status", "sent")
      .gte("sent_at", sinceIso);
    if (untilIso) postQuery = postQuery.lte("sent_at", untilIso);

    const { data: posts, error } = await postQuery
      .order("sent_at", { ascending: false })
      .limit(LIST_LIMIT);
    if (error) throw new InternalServerErrorException(error.message);

    // Latest stored insight per target (the cron keeps exactly one row/target).
    const targetIds: string[] = [];
    for (const p of posts || []) for (const t of p.post_targets || []) targetIds.push(t.id);
    const insightsByTarget: Record<string, any> = {};
    if (targetIds.length) {
      const { data: rows } = await supabase
        .from("post_insights")
        .select("post_target_id, likes, comments, shares, reach, impressions, engagement_rate, fetched_at")
        .in("post_target_id", targetIds);
      for (const r of rows || []) insightsByTarget[r.post_target_id] = r;
    }

    const results = (posts || []).map((p: any) => {
      const targets = (p.post_targets || []).filter((t: any) => t.status === "sent");
      let likes = 0,
        comments = 0,
        shares = 0,
        reach = 0,
        impressions = 0,
        withInsights = 0;
      let fetchedAt: string | null = null;

      const perTarget = targets.map((t: any) => {
        const ins = insightsByTarget[t.id] || null;
        if (ins) {
          likes += ins.likes || 0;
          comments += ins.comments || 0;
          shares += ins.shares || 0;
          reach += ins.reach || 0;
          impressions += ins.impressions || 0;
          withInsights++;
          if (ins.fetched_at && (!fetchedAt || ins.fetched_at > fetchedAt)) fetchedAt = ins.fetched_at;
        }
        const acct = t.social_accounts || {};
        return {
          targetId: t.id,
          platform: t.platform,
          // null when the account was disconnected — filtered out of `pages`
          // below so dangling targets don't show up as "Unknown".
          page: acct.display_name || null,
          externalPostId: t.external_post_id,
          permalink: t.permalink || null,
          likes: ins?.likes ?? null,
          comments: ins?.comments ?? null,
          shares: ins?.shares ?? null,
          reach: ins?.reach ?? null,
          // "Views" is what every platform now calls this and what the rest of
          // the app shows (Post Analytics maps the same column). The COLUMN is
          // still `impressions` because that is what these APIs were called
          // when it was added — Facebook's post_media_view, Instagram's views
          // and YouTube's views all land in it.
          views: ins?.impressions ?? null,
          hasInsights: !!ins,
        };
      });

      return {
        id: p.id,
        body: p.body,
        image_url: p.image_url,
        link_url: p.link_url,
        content_type: p.content_type,
        sent_at: p.sent_at,
        category: targets[0]?.social_accounts?.category || "Other",
        postType: this.derivePostType(p),
        pages: perTarget.map((t: any) => t.page).filter(Boolean),
        platforms: [...new Set(perTarget.map((t: any) => t.platform))],
        likes,
        comments,
        shares,
        reach,
        views: impressions,
        engagement: likes + comments + shares,
        hasInsights: withInsights > 0,
        fetchedAt,
        targets: perTarget,
      };
    });

    return {
      posts: results,
      windowDays,
      // Echoed back so the header can name the actual range rather than
      // "last N days", which is a lie for a custom one.
      start: start || null,
      end: end || null,
      custom: !!(start && end),
      // A custom range can ask for far more than the row cap, and a total that
      // quietly stopped at 500 posts would be read as the real number. Say so
      // instead.
      truncated: (posts || []).length >= LIST_LIMIT,
      limit: LIST_LIMIT,
    };
  }

  // Turn { days } or { start, end } into an ISO window. Shared by all three
  // entry points — the Performance rollup, the Post Analytics table and the
  // refresh job — so a range means the same thing in every one of them. That
  // matters most for refresh(): it re-pulls metrics for the window the caller
  // is LOOKING at, so a range it read differently would leave exactly the posts
  // on screen un-refreshed.
  //
  // Dates are read as UTC day boundaries, matching how postsDetailed has always
  // done it. `end` is inclusive — someone picking the same day twice means that
  // day, not an empty window.
  private resolveRange(query: any, maxDays: number) {
    const start = typeof query?.start === "string" ? query.start.trim() : "";
    const end = typeof query?.end === "string" ? query.end.trim() : "";

    if (start || end) {
      if (!start || !end) throw new BadRequestException("A custom range needs both a start and an end date.");
      const from = new Date(`${start}T00:00:00.000Z`);
      const to = new Date(`${end}T23:59:59.999Z`);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new BadRequestException("Invalid date in the custom range.");
      }
      if (to.getTime() < from.getTime()) {
        throw new BadRequestException("The custom range ends before it starts.");
      }
      return {
        sinceIso: from.toISOString(),
        untilIso: to.toISOString(),
        windowDays: Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000)),
        start,
        end,
      };
    }

    const windowDays = Math.min(Math.max(Number(query?.days) || 30, 1), maxDays);
    return {
      sinceIso: new Date(Date.now() - windowDays * 86400000).toISOString(),
      untilIso: null as string | null,
      windowDays,
      start: "",
      end: "",
    };
  }

  // GET /api/insights/posts?days=30 (or ?start=YYYY-MM-DD&end=YYYY-MM-DD) —
  // one row per post×page with content details + every stored metric, for the
  // detailed Post Analytics table. Only published targets (external_post_id set).
  async postsDetailed(query: any) {
    const supabase = this.supabaseService.createServiceClient();
    // Same range rules as list(), including rejecting a half-given or invalid
    // custom range. This used to fall back to "last 30 days" on a bad date,
    // which answered a question nobody asked and looked like a real result.
    const { sinceIso, untilIso } = this.resolveRange(query, 365);

    let q = supabase
      .from("scheduled_posts")
      .select(
        "id, body, image_url, media, link_url, content_type, platform_options, sent_at, scheduled_for, status, source, created_by, post_targets(id, platform, status, external_post_id, permalink, sent_at, social_accounts(id, display_name, platform, category, avatar_url))",
      )
      .eq("user_id", OWNER_ID)
      .in("status", ["sent", "deleted"])
      .gte("scheduled_for", sinceIso)
      .order("scheduled_for", { ascending: false })
      .limit(1000);
    if (untilIso) q = q.lte("scheduled_for", untilIso);

    const { data: posts, error } = await q;
    if (error) throw new InternalServerErrorException(error.message);

    // Latest stored insight per published target.
    const targetIds: string[] = [];
    for (const p of posts || []) for (const t of p.post_targets || []) if (t.external_post_id) targetIds.push(t.id);
    const insByTarget: Record<string, any> = {};
    if (targetIds.length) {
      const { data: insRows } = await supabase.from("post_insights").select("*").in("post_target_id", targetIds);
      for (const r of insRows || []) insByTarget[r.post_target_id] = r;
    }

    const rows: any[] = [];
    const byKey: Record<string, any> = {}; // `${platform}:${externalPostId}` → row, for dedup/merge

    // ── App-made posts (every platform) ──
    for (const p of posts || []) {
      const postType = this.derivePostType(p);
      for (const t of p.post_targets || []) {
        if (!t.external_post_id) continue; // only published targets have metrics
        const acct = t.social_accounts || {};
        const ins = insByTarget[t.id] || null;
        const likes = ins?.likes ?? null;
        const comments = ins?.comments ?? null;
        const shares = ins?.shares ?? null;
        const saves = ins?.saves ?? null;
        const reach = ins?.reach ?? null;
        const interactions =
          ins?.total_interactions ??
          (ins ? (likes || 0) + (comments || 0) + (shares || 0) + (saves || 0) : null);
        const engagement = (likes || 0) + (comments || 0) + (shares || 0);
        const engagementRate = ins?.engagement_rate ?? (reach ? +((engagement / reach) * 100).toFixed(2) : null);

        const row = {
          rowId: `${p.id}:${t.id}`,
          postId: p.id,
          targetId: t.id,
          platform: t.platform,
          page: acct.display_name || "Unknown",
          accountId: acct.id || null,
          category: acct.category || "Other",
          avatarUrl: acct.avatar_url || null,
          title: p.body || "",
          thumbnailUrl: p.image_url || null,
          externalPostId: t.external_post_id,
          // Set for postiz-backed targets, whose ids map to no public URL —
          // the table's View link falls back to id-derived URLs without it.
          permalink: t.permalink || null,
          contentType: p.content_type || null,
          postType,
          platformOptions: p.platform_options || null,
          source: p.source || "app",
          origin: "app",
          datePublished: t.sent_at || p.sent_at || p.scheduled_for,
          status: t.status,
          createdBy: p.created_by || null,
          hasInsights: !!ins,
          metrics: {
            views: ins?.impressions ?? null,
            reach,
            viewers: ins?.viewers ?? null,
            interactions,
            likes,
            comments,
            shares,
            saves,
            linkClicks: ins?.clicks ?? null,
            replies: ins?.replies ?? null,
            follows: ins?.follows ?? null,
            threeSecondViews: ins?.three_second_views ?? null,
            watchTime: ins?.video_watch_time != null ? Number(ins.video_watch_time) : null,
            avgPlayTime: ins?.video_avg_time != null ? Number(ins.video_avg_time) : null,
            engagementRate,
          },
        };
        rows.push(row);
        byKey[`${row.platform}:${row.externalPostId}`] = row;
      }
    }

    // ── Synced page content (FB/IG, organic + app) ──
    // A synced post that matches an app-made target upgrades that row's metrics
    // (the sync is the freshest, page-authoritative pull); one with no match
    // becomes an "organic" row (posted outside this app).
    let sq = supabase
      .from("social_posts")
      .select("*")
      .gte("posted_at", sinceIso)
      .order("posted_at", { ascending: false })
      .limit(2000);
    if (untilIso) sq = sq.lte("posted_at", untilIso);
    const { data: socialPosts } = await sq;

    if (socialPosts && socialPosts.length) {
      const { data: accts } = await supabase
        .from("social_accounts")
        .select("id, display_name, platform, category, avatar_url")
        .eq("user_id", OWNER_ID);
      const acctById: Record<string, any> = {};
      for (const a of accts || []) acctById[a.id] = a;

      for (const sp of socialPosts) {
        const metrics = this.socialMetrics(sp);
        const existing = byKey[`${sp.platform}:${sp.external_post_id}`];
        if (existing) {
          existing.metrics = metrics;
          existing.hasInsights = true;
        } else {
          const acct = acctById[sp.social_account_id] || {};
          rows.push({
            rowId: `sp:${sp.id}`,
            postId: null,
            targetId: null,
            platform: sp.platform,
            page: acct.display_name || sp.author_name || "Unknown",
            accountId: sp.social_account_id,
            category: acct.category || "Other",
            avatarUrl: acct.avatar_url || null,
            title: sp.message || "",
            thumbnailUrl: sp.thumbnail_url || sp.media_url || null,
            externalPostId: sp.external_post_id,
            // social_posts has carried a real permalink from the Graph sync all
            // along; it just was never handed to the table, so organic
            // Instagram rows showed no View link despite having a URL.
            permalink: sp.permalink || null,
            contentType: null,
            postType: sp.post_type || "status",
            platformOptions: null,
            source: "organic",
            origin: "organic",
            datePublished: sp.posted_at,
            status: sp.is_published === false ? "unpublished" : "sent",
            createdBy: null,
            hasInsights: true,
            metrics,
          });
        }
      }
    }

    // Newest first across the merged set.
    rows.sort((a, b) => new Date(b.datePublished || 0).getTime() - new Date(a.datePublished || 0).getTime());

    return { rows, count: rows.length };
  }

  // Metrics object from a social_posts row — same shape as the app-row metrics.
  private socialMetrics(sp: any) {
    const likes = sp.likes ?? null, comments = sp.comments ?? null, shares = sp.shares ?? null, saves = sp.saves ?? null;
    const reach = sp.reach ?? null;
    const interactions = sp.total_interactions ?? ((likes || 0) + (comments || 0) + (shares || 0) + (saves || 0));
    const engagement = (likes || 0) + (comments || 0) + (shares || 0);
    return {
      views: sp.impressions ?? null,
      reach,
      viewers: sp.viewers ?? null,
      interactions,
      likes,
      comments,
      shares,
      saves,
      linkClicks: sp.clicks ?? null,
      replies: sp.replies ?? null,
      follows: sp.follows ?? null,
      threeSecondViews: sp.three_second_views ?? null,
      watchTime: sp.video_watch_time != null ? Number(sp.video_watch_time) : null,
      avgPlayTime: sp.video_avg_time != null ? Number(sp.video_avg_time) : null,
      engagementRate: reach ? +((engagement / reach) * 100).toFixed(2) : null,
    };
  }

  // Coarse content type for the type filter, from the stored media array.
  private derivePostType(p: any): "video" | "photo" | "link" | "text" {
    const media = Array.isArray(p.media) ? p.media : [];
    if (media.some((m: any) => m?.type === "video")) return "video";
    if (media.some((m: any) => m?.type === "image") || p.image_url) return "photo";
    if (p.link_url) return "link";
    return "text";
  }

  // POST /api/insights/refresh { postId?, days?, start?, end? } — fetch live
  // metrics by post id via the platform APIs and upsert post_insights. Scoped to
  // one post, or the sent set within a window. The window MUST match what the
  // caller is viewing: the Post Analytics page passes its own range so posts
  // older than 30 days still get refreshed (otherwise their Reach/Views stay
  // blank even though the row is shown).
  async refresh(body: any) {
    const supabase = this.supabaseService.createServiceClient();
    const postId = body?.postId || null;
    const { sinceIso, untilIso } = this.resolveRange(body, 365);

    let q = supabase
      .from("post_targets")
      .select(
        "id, external_post_id, platform, sent_at, post_id, social_accounts(id, display_name, access_token, platform, publish_via, external_account_id, metadata)",
      )
      .eq("status", "sent")
      .in("platform", ["facebook", "instagram", "threads", "twitter", "youtube"])
      .not("external_post_id", "is", null);
    if (postId) {
      q = q.eq("post_id", postId);
    } else {
      q = q.gte("sent_at", sinceIso).order("sent_at", { ascending: false }).limit(500);
      if (untilIso) q = q.lte("sent_at", untilIso);
    }

    const { data: targets, error } = await q;
    if (error) throw new InternalServerErrorException(error.message);

    let synced = 0,
      failed = 0;
    for (const target of targets || []) {
      if (!target.social_accounts || String(target.external_post_id).includes("_mock_")) continue;
      try {
        const m = await this.fetchMetrics(target.platform, target.social_accounts, target.external_post_id);
        await supabase.from("post_insights").delete().eq("post_target_id", target.id);
        await supabase.from("post_insights").insert(buildPostInsightRow(target, m));
        synced++;
      } catch (err) {
        failed++;
        console.warn(`[insights.refresh] failed for target ${target.id}:`, err.message);
      }
    }
    return { synced, failed };
  }

  private async fetchMetrics(platform: string, account: any, externalPostId: string): Promise<any> {
    // Postiz reports analytics per ITS post id, not the platform's, and one call
    // serves both Threads and Instagram — so route on how the account publishes
    // before looking at the platform at all.
    if (account?.publish_via === "postiz") return getPostizPostMetrics({ externalPostId });
    if (platform === "instagram") return getInstagramPostMetrics({ account, externalPostId });
    if (platform === "youtube") {
      const yt = await getYouTubeVideoAnalytics({ account, videoId: externalPostId });
      return { likes: yt.likes, comments: yt.comments, shares: 0, impressions: yt.views, reach: null, raw: yt.raw };
    }
    return getFacebookPostMetrics({ account, externalPostId });
  }
}
