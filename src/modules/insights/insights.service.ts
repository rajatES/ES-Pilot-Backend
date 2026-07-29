import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
// @ts-ignore - plain JS platform clients (shared with the cron insights job).
import { getFacebookPostMetrics } from "../../lib/facebook";
// @ts-ignore
import { getInstagramPostMetrics } from "../../lib/instagram";
// @ts-ignore
import { getThreadsPostMetrics } from "../../lib/threads";
// @ts-ignore
import { getXPostMetrics } from "../../lib/x";
// @ts-ignore
import { getYouTubeVideoAnalytics } from "../../lib/youtube";

// Per-post performance, built from the same platform metric APIs the insights
// cron already uses — fetched by external_post_id, never scraped.
@Injectable()
export class InsightsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // GET /api/insights?days=30 — rollup of stored insights per sent post.
  async list(days = 30) {
    const supabase = this.supabaseService.createServiceClient();
    const windowDays = Math.min(Math.max(Number(days) || 30, 1), 90);
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();

    const { data: posts, error } = await supabase
      .from("scheduled_posts")
      .select(
        "id, body, image_url, link_url, content_type, sent_at, status, post_targets(id, platform, status, external_post_id, social_accounts(display_name, platform, category))",
      )
      .eq("user_id", OWNER_ID)
      .eq("status", "sent")
      .gte("sent_at", since)
      .order("sent_at", { ascending: false })
      .limit(500);
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
          page: acct.display_name || "Unknown",
          externalPostId: t.external_post_id,
          likes: ins?.likes ?? null,
          comments: ins?.comments ?? null,
          shares: ins?.shares ?? null,
          reach: ins?.reach ?? null,
          impressions: ins?.impressions ?? null,
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
        pages: perTarget.map((t: any) => t.page),
        platforms: [...new Set(perTarget.map((t: any) => t.platform))],
        likes,
        comments,
        shares,
        reach,
        impressions,
        engagement: likes + comments + shares,
        hasInsights: withInsights > 0,
        fetchedAt,
        targets: perTarget,
      };
    });

    return { posts: results, windowDays };
  }

  // GET /api/insights/posts?days=30 (or ?start=YYYY-MM-DD&end=YYYY-MM-DD) —
  // one row per post×page with content details + every stored metric, for the
  // detailed Post Analytics table. Only published targets (external_post_id set).
  async postsDetailed(query: any) {
    const supabase = this.supabaseService.createServiceClient();
    const days = Math.min(Math.max(Number(query?.days) || 30, 1), 365);
    let sinceIso: string;
    let untilIso: string | null = null;
    if (query?.start && query?.end) {
      sinceIso = new Date(`${query.start}T00:00:00.000Z`).toISOString();
      untilIso = new Date(`${query.end}T23:59:59.999Z`).toISOString();
    } else {
      sinceIso = new Date(Date.now() - days * 86400000).toISOString();
    }

    let q = supabase
      .from("scheduled_posts")
      .select(
        "id, body, image_url, media, link_url, content_type, platform_options, sent_at, scheduled_for, status, source, created_by, post_targets(id, platform, status, external_post_id, sent_at, social_accounts(id, display_name, platform, category, avatar_url))",
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
    if (media.some((m: any) => m?.type === "image")) return "photo";
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
    const days = Math.min(Math.max(Number(body?.days) || 30, 1), 365);
    let sinceIso: string;
    let untilIso: string | null = null;
    if (body?.start && body?.end) {
      sinceIso = new Date(`${body.start}T00:00:00.000Z`).toISOString();
      untilIso = new Date(`${body.end}T23:59:59.999Z`).toISOString();
    } else {
      sinceIso = new Date(Date.now() - days * 86400000).toISOString();
    }

    let q = supabase
      .from("post_targets")
      .select(
        "id, external_post_id, platform, sent_at, post_id, social_accounts(id, display_name, access_token, platform, external_account_id)",
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
        const engagement = (m.likes || 0) + (m.comments || 0) + (m.shares || 0);
        const engagementRate = m.reach ? +((engagement / m.reach) * 100).toFixed(2) : null;
        await supabase.from("post_insights").delete().eq("post_target_id", target.id);
        await supabase.from("post_insights").insert({
          post_target_id: target.id,
          external_post_id: target.external_post_id,
          platform: target.platform,
          likes: m.likes ?? null,
          comments: m.comments ?? null,
          shares: m.shares ?? null,
          impressions: m.impressions ?? null,
          reach: m.reach ?? null,
          viewers: m.viewers ?? null,
          clicks: m.clicks ?? null,
          saves: m.saves ?? null,
          total_interactions: m.total_interactions ?? null,
          three_second_views: m.three_second_views ?? null,
          video_watch_time: m.video_watch_time ?? null,
          video_avg_time: m.video_avg_time ?? null,
          follows: m.follows ?? null,
          replies: m.replies ?? null,
          engagement_rate: engagementRate,
          fetched_at: new Date().toISOString(),
          raw: m.raw || {},
        });
        synced++;
      } catch (err) {
        failed++;
        console.warn(`[insights.refresh] failed for target ${target.id}:`, err.message);
      }
    }
    return { synced, failed };
  }

  private async fetchMetrics(platform: string, account: any, externalPostId: string): Promise<any> {
    if (platform === "instagram") return getInstagramPostMetrics({ account, externalPostId });
    if (platform === "threads") return getThreadsPostMetrics({ account, externalPostId });
    if (platform === "twitter") return getXPostMetrics({ account, externalPostId });
    if (platform === "youtube") {
      const yt = await getYouTubeVideoAnalytics({ account, videoId: externalPostId });
      return { likes: yt.likes, comments: yt.comments, shares: 0, impressions: yt.views, reach: null, raw: yt.raw };
    }
    return getFacebookPostMetrics({ account, externalPostId });
  }
}
