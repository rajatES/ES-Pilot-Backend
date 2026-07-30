// Single source of truth for a `post_insights` row built from a platform
// metrics object (the shape returned by getFacebookPostMetrics /
// getInstagramPostMetrics / getThreadsPostMetrics / getXPostMetrics / the
// YouTube adapter).
//
// Both writers — the periodic insights cron and the manual refresh — MUST build
// the row through here so they can't drift. They did drift: the cron used to
// persist only likes/comments/shares/impressions/reach and silently dropped
// every video + extended metric (watch time, avg play, 3-second views, viewers,
// saves, clicks, …), so video analytics were blanked every time the 4-hourly
// cron overwrote a row.
export function buildPostInsightRow(target, m) {
  const engagement = (m.likes || 0) + (m.comments || 0) + (m.shares || 0);
  const engagementRate = m.reach ? +((engagement / m.reach) * 100).toFixed(2) : null;
  return {
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
  };
}
