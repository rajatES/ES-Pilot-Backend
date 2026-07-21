import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";

@Injectable()
export class DashboardService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // One call returns every metric the operations dashboard needs. Aggregation
  // is done in JS over recent rows — fine at current scale.
  async get() {
    const supabase = this.supabaseService.createServiceClient();

    const [postsRes, accountsRes, activityRes, insightsRes] = await Promise.all([
      supabase
        .from("scheduled_posts")
        .select(
          "id,status,scheduled_for,sent_at,created_at,body,image_url,link_url,post_targets(platform,status,social_account_id,social_accounts(id,display_name,platform,category))",
        )
        .eq("user_id", OWNER_ID)
        .order("scheduled_for", { ascending: false })
        .limit(2000),
      supabase.from("social_accounts").select("id,display_name,platform,category,followers").eq("user_id", OWNER_ID),
      supabase
        .from("activity_log")
        .select("*")
        .eq("user_id", OWNER_ID)
        .order("created_at", { ascending: false })
        .limit(40),
      supabase
        .from("post_insights")
        .select(
          "likes, comments, shares, reach, impressions, engagement_rate, fetched_at, post_targets(post_id, social_accounts(display_name), scheduled_posts(id, body, image_url, link_url, sent_at))",
        )
        .order("fetched_at", { ascending: false })
        .limit(200),
    ]);

    if (postsRes.error) throw new InternalServerErrorException(postsRes.error.message);

    const posts = postsRes.data || [];
    const accounts = accountsRes.data || [];
    const activity = activityRes.data || [];

    const now = new Date();
    const sameDay = (d1: Date, d2: Date) =>
      d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86400000);

    // ── Status counts ──
    const statusCounts: any = {
      draft: 0,
      pending_review: 0,
      approved: 0,
      rejected: 0,
      scheduled: 0,
      publishing: 0,
      sent: 0,
      failed: 0,
    };
    for (const p of posts) if (statusCounts[p.status] !== undefined) statusCounts[p.status]++;

    // ── Account counts ──
    const accountCounts = {
      total: accounts.length,
      facebook: accounts.filter((a) => a.platform === "facebook").length,
      instagram: accounts.filter((a) => a.platform === "instagram").length,
      followers: accounts.reduce((s, a) => s + (a.followers || 0), 0),
    };

    // ── Time-window counts ──
    const weekEnd = new Date(now.getTime() + 7 * 86400000);
    const postsToday = posts.filter((p) => sameDay(new Date(p.scheduled_for), now)).length;
    const postsThisWeek = posts.filter((p) => {
      const d = new Date(p.scheduled_for);
      return d >= now && d <= weekEnd;
    }).length;
    const publishedToday = posts.filter(
      (p) => p.status === "sent" && p.sent_at && sameDay(new Date(p.sent_at), now),
    ).length;

    const last30 = posts.filter((p) => new Date(p.created_at) >= daysAgo(30)).length;
    const avgPerDay = +(last30 / 30).toFixed(1);

    // ── Upcoming scheduled ──
    const upcoming = posts
      .filter((p) => p.status === "scheduled" && new Date(p.scheduled_for) >= now)
      .sort((a, b) => +new Date(a.scheduled_for) - +new Date(b.scheduled_for))
      .slice(0, 8);

    // ── Coverage gaps: Pages with nothing upcoming in the next 48h ──
    const coverageWindowEnd = new Date(now.getTime() + 48 * 3600000);
    const upcomingStatuses = new Set(["scheduled", "publishing", "pending_review", "approved"]);
    const coveredAccountIds = new Set();
    for (const p of posts) {
      if (!upcomingStatuses.has(p.status)) continue;
      const when = new Date(p.scheduled_for);
      if (when < now || when > coverageWindowEnd) continue;
      for (const t of p.post_targets || []) {
        if (t.social_account_id) coveredAccountIds.add(t.social_account_id);
      }
    }
    const coverageGaps = accounts
      .filter((a) => !coveredAccountIds.has(a.id))
      .map((a) => ({ id: a.id, displayName: a.display_name, platform: a.platform, category: a.category || "Other" }));

    // ── Charts ──
    const byDay = [];
    for (let i = 13; i >= 0; i--) {
      const d = daysAgo(i);
      const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const count = posts.filter((p) => sameDay(new Date(p.scheduled_for), d)).length;
      byDay.push({ day: label, posts: count });
    }

    const platformMap: any = {};
    const sportMap: any = {};
    const pageMap: any = {};
    let sent = 0,
      failed = 0;
    for (const p of posts) {
      for (const t of p.post_targets || []) {
        const plat = t.platform || (t.social_accounts as any)?.platform || "unknown";
        platformMap[plat] = (platformMap[plat] || 0) + 1;
        const sport = (t.social_accounts as any)?.category || "Other";
        sportMap[sport] = (sportMap[sport] || 0) + 1;
        const page = (t.social_accounts as any)?.display_name || "Unknown";
        pageMap[page] = (pageMap[page] || 0) + 1;
        if (t.status === "sent") sent++;
        else if (t.status === "failed") failed++;
      }
    }

    const byPlatform = Object.entries(platformMap).map(([name, value]) => ({ name, value }));
    const bySport = Object.entries(sportMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a: any, b: any) => b.value - a.value);
    const topPages = Object.entries(pageMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a: any, b: any) => b.value - a.value)
      .slice(0, 6);
    const topSports = bySport.slice(0, 6);
    const successRate = sent + failed > 0 ? Math.round((sent / (sent + failed)) * 100) : null;

    // ── Top posts by engagement (from synced insights) ──
    const postAgg = new Map();
    for (const row of insightsRes.data || []) {
      const t: any = row.post_targets;
      const p = t?.scheduled_posts;
      if (!p) continue;
      const agg = postAgg.get(p.id) || {
        id: p.id,
        body: p.body,
        image_url: p.image_url,
        link_url: p.link_url,
        sent_at: p.sent_at,
        likes: 0,
        comments: 0,
        shares: 0,
        reach: 0,
        impressions: 0,
        pages: [],
      };
      agg.likes += row.likes || 0;
      agg.comments += row.comments || 0;
      agg.shares += row.shares || 0;
      agg.reach += row.reach || 0;
      agg.impressions += row.impressions || 0;
      if (t.social_accounts?.display_name) agg.pages.push(t.social_accounts.display_name);
      postAgg.set(p.id, agg);
    }
    const topPosts = [...postAgg.values()]
      .map((p) => ({ ...p, engagement: p.likes + p.comments + p.shares }))
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 5);
    const totalEngagement = [...postAgg.values()].reduce((s, p) => s + p.likes + p.comments + p.shares, 0);

    return {
      topPosts,
      totalEngagement,
      statusCounts,
      accountCounts,
      postsToday,
      postsThisWeek,
      publishedToday,
      avgPerDay,
      totalPosts: posts.length,
      upcoming,
      coverageGaps,
      recentActivity: activity,
      recentFailures: activity.filter((a) => a.status === "error").slice(0, 8),
      recentReconnects: activity.filter((a) => a.type === "account.connected").slice(0, 8),
      charts: { byDay, byPlatform, bySport, topPages, topSports, successRate, sent, failed },
    };
  }
}
