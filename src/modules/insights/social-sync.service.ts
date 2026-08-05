import { ForbiddenException, Injectable } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { StorageService } from "../../storage/storage.service";
// @ts-ignore - plain JS platform clients.
import { listFacebookPagePosts, getFacebookPostMetrics } from "../../lib/facebook";
// @ts-ignore
import { listInstagramMedia, getInstagramPostMetrics } from "../../lib/instagram";

// Pulls EVERY post from each connected Facebook/Instagram account (organic +
// app-made) into social_posts with fresh metrics, so Post Analytics can show
// the full page — not just posts published through this app. Meta only for now;
// other platforms stay app-made-only.
const MAX_PER_ACCOUNT = 200;

@Injectable()
export class SocialSyncService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly storage: StorageService,
  ) {}

  // Already a copy on our own S3 — skip re-downloading.
  private isOurStorage(url: string | null): boolean {
    if (!url) return false;
    try {
      return url.startsWith(this.storage.publicUrl(""));
    } catch {
      return false;
    }
  }

  // FB/IG thumbnail URLs are signed CDN links that expire after a day or two.
  // Copy the image to our S3 so it stays valid. On failure keep the CDN URL.
  private async mirrorThumbnail(cdnUrl: string | null, keyBase: string): Promise<string | null> {
    if (!cdnUrl) return null;
    try {
      const res = await fetch(cdnUrl);
      if (!res.ok) return cdnUrl;
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type") || "image/jpeg";
      const ext = /png/.test(ct) ? "png" : /webp/.test(ct) ? "webp" : /gif/.test(ct) ? "gif" : "jpg";
      const key = `social-thumbs/${keyBase.replace(/[^a-zA-Z0-9_-]/g, "_")}.${ext}`;
      const { url } = await this.storage.put(key, buf, ct);
      return url;
    } catch (e: any) {
      console.warn("[social-sync] thumbnail mirror failed:", e.message);
      return cdnUrl;
    }
  }

  // Window from days/start/end — same convention as InsightsService.refresh.
  private window(body: any) {
    const days = Math.min(Math.max(Number(body?.days) || 30, 1), 365);
    if (body?.start && body?.end) {
      return { since: new Date(`${body.start}T00:00:00.000Z`), until: new Date(`${body.end}T23:59:59.999Z`) };
    }
    return { since: new Date(Date.now() - days * 86400000), until: new Date() };
  }

  private fbPostType(p: any): string {
    const att = p.attachments?.data?.[0];
    const mt = att?.media_type || att?.type || "";
    const st = p.status_type || "";
    if (/video/i.test(mt) || /video/i.test(st)) return "video";
    if (/photo/i.test(mt) || /photo|image/i.test(st)) return "photo";
    if (/share|link/i.test(mt)) return "link";
    if (p.message) return "status";
    return "status";
  }

  private igPostType(m: any): string {
    if (m.media_product_type === "REELS") return "reel";
    if (m.media_product_type === "STORY") return "story";
    if (m.media_type === "VIDEO") return "video";
    if (m.media_type === "CAROUSEL_ALBUM") return "carousel";
    return "photo";
  }

  // POST /api/insights/sync (admin) and the cron entry both land here. `me` is
  // null for cron (already authorized by CRON_SECRET); a JWT caller must be admin.
  async sync(me: any, body: any = {}) {
    if (me && me.role !== "admin") {
      throw new ForbiddenException("Only admins can sync page content.");
    }
    const db = this.supabaseService.createServiceClient();
    const { since, until } = this.window(body);

    const { data: accounts } = await db
      .from("social_accounts")
      .select("*")
      .eq("user_id", OWNER_ID)
      .in("platform", ["facebook", "instagram"]);

    let listed = 0, synced = 0, failed = 0;
    const perAccount: any[] = [];

    for (const account of accounts || []) {
      // Existing rows for this account → insert vs update by external_post_id.
      const { data: existingRows } = await db
        .from("social_posts")
        .select("id, external_post_id, thumbnail_url")
        .eq("social_account_id", account.id);
      const existingByExt: Record<string, any> = {};
      for (const r of existingRows || []) existingByExt[r.external_post_id] = r;

      let posts: any[] = [];
      try {
        posts =
          account.platform === "facebook"
            ? await listFacebookPagePosts({ account, since, until, max: MAX_PER_ACCOUNT })
            : await listInstagramMedia({ account, since, until, max: MAX_PER_ACCOUNT });
      } catch (e: any) {
        failed++;
        perAccount.push({ account: account.display_name, platform: account.platform, error: e.message });
        continue;
      }
      listed += posts.length;
      let acctSynced = 0;

      for (const p of posts) {
        const extId = p.id;
        try {
          const m =
            account.platform === "facebook"
              ? await getFacebookPostMetrics({ account, externalPostId: extId })
              : await getInstagramPostMetrics({ account, externalPostId: extId });

          const common = {
            social_account_id: account.id,
            platform: account.platform,
            external_post_id: extId,
            likes: m.likes ?? null,
            comments: m.comments ?? null,
            shares: m.shares ?? null,
            reach: m.reach ?? null,
            impressions: m.impressions ?? null,
            viewers: m.viewers ?? null,
            video_watch_time: m.video_watch_time ?? null,
            video_avg_time: m.video_avg_time ?? null,
            follows: null,
            replies: null,
            fetched_at: new Date().toISOString(),
            raw: {},
          };

          const row =
            account.platform === "facebook"
              ? {
                  ...common,
                  post_type: this.fbPostType(p),
                  message: p.message || p.story || null,
                  media_url: p.full_picture || null,
                  thumbnail_url: p.full_picture || null,
                  permalink: p.permalink_url || null,
                  posted_at: p.created_time ? new Date(p.created_time).toISOString() : null,
                  is_published: p.is_published !== false,
                  author_name: p.from?.name || account.display_name || null,
                  clicks: m.clicks ?? null,
                  saves: null,
                  total_interactions: null,
                  three_second_views: m.three_second_views ?? null,
                }
              : {
                  ...common,
                  post_type: this.igPostType(p),
                  message: p.caption || null,
                  media_url: p.media_url || null,
                  thumbnail_url: p.thumbnail_url || p.media_url || null,
                  permalink: p.permalink || null,
                  posted_at: p.timestamp ? new Date(p.timestamp).toISOString() : null,
                  is_published: true,
                  author_name: account.display_name || null,
                  clicks: null,
                  saves: m.saves ?? null,
                  total_interactions: m.total_interactions ?? null,
                  three_second_views: null,
                };

          const existing = existingByExt[extId];

          // Reuse an existing mirror, else copy the fresh CDN thumbnail to S3.
          if (existing && this.isOurStorage(existing.thumbnail_url)) {
            row.thumbnail_url = existing.thumbnail_url;
          } else if (row.thumbnail_url) {
            row.thumbnail_url = await this.mirrorThumbnail(row.thumbnail_url, `${account.platform}_${extId}`);
          }

          if (existing) await db.from("social_posts").update(row).eq("id", existing.id);
          else await db.from("social_posts").insert(row);
          synced++;
          acctSynced++;
        } catch (err: any) {
          failed++;
          console.warn(`[social-sync] ${account.platform} ${extId}:`, err.message);
        }
      }
      perAccount.push({ account: account.display_name, platform: account.platform, listed: posts.length, synced: acctSynced });
    }

    return { accounts: (accounts || []).length, listed, synced, failed, perAccount };
  }
}
