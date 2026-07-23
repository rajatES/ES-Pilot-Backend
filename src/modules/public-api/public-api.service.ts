import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { PostsService } from "../posts/posts.service";
import { UploadService } from "../upload/upload.service";

// External Developer API (v1) — the SocialPilot-style surface automations
// call with an API key. Thin façade: normalizes the external payload shape,
// validates it with clear messages (no frontend guarding these callers),
// then delegates to the same PostsService pipeline the app UI uses.

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv)(\?.*)?$/i;
const MAX_REMOTE_MEDIA_BYTES = 200 * 1024 * 1024; // matches the upload cap

function inferMediaType(url: string): "image" | "video" {
  return VIDEO_EXT.test(url) ? "video" : "image";
}

// Public shape for a post row + its targets — never leaks tokens or hashes.
function toApiPost(post: any) {
  return {
    id: post.id,
    content: post.body,
    media: post.media || (post.image_url ? [{ url: post.image_url, type: "image" }] : []),
    linkUrl: post.link_url,
    firstComment: post.first_comment,
    contentType: post.content_type,
    platformCaptions: post.platform_captions || null,
    platformOptions: post.platform_options || null,
    status: post.status,
    approvalStatus: post.approval_status,
    scheduledFor: post.scheduled_for,
    sentAt: post.sent_at,
    createdAt: post.created_at,
    targets: (post.post_targets || []).map((t: any) => ({
      accountId: t.social_account_id,
      accountName: t.social_accounts?.display_name,
      platform: t.platform,
      status: t.status,
      externalPostId: t.external_post_id,
      error: t.last_error,
      sentAt: t.sent_at,
    })),
  };
}

@Injectable()
export class PublicApiService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly posts: PostsService,
    private readonly upload: UploadService,
  ) {}

  // GET /api/v1/accounts — the IDs automations target in POST /v1/posts.
  async listAccounts() {
    const db = this.supabaseService.createServiceClient();
    const { data, error } = await db
      .from("social_accounts")
      .select("id, platform, display_name, external_account_id, status, category, created_at")
      .eq("user_id", OWNER_ID)
      .order("created_at", { ascending: false });
    if (error) throw new InternalServerErrorException(error.message);
    return {
      accounts: (data || []).map((a: any) => ({
        id: a.id,
        platform: a.platform,
        name: a.display_name,
        externalAccountId: a.external_account_id,
        status: a.status,
        category: a.category,
      })),
    };
  }

  // POST /api/v1/posts — create + publish/schedule/queue/review/draft.
  async createPost(payload: any, profile: any) {
    const p = payload || {};

    const content = (p.content ?? p.text ?? p.body ?? "").trim();
    if (!content) throw new BadRequestException("'content' is required.");

    const accountIds = Array.isArray(p.accountIds) ? p.accountIds.filter(Boolean) : [];
    if (!accountIds.length) {
      throw new BadRequestException("'accountIds' must be a non-empty array — see GET /api/v1/accounts.");
    }

    // Validate every requested account up front so a typo'd ID fails loudly
    // instead of being silently dropped by the shared pipeline.
    const db = this.supabaseService.createServiceClient();
    const { data: found } = await db
      .from("social_accounts")
      .select("id")
      .in("id", accountIds)
      .eq("user_id", OWNER_ID);
    const foundIds = new Set((found || []).map((a: any) => a.id));
    const missing = accountIds.filter((id: string) => !foundIds.has(id));
    if (missing.length) {
      throw new BadRequestException(`Unknown account id(s): ${missing.join(", ")} — see GET /api/v1/accounts.`);
    }

    // Media: either media:[{url,type}] or mediaUrls:[string] (type inferred).
    const media: any[] = [];
    for (const m of Array.isArray(p.media) ? p.media : []) {
      if (!m?.url) throw new BadRequestException("Each 'media' entry needs a 'url'.");
      media.push({ url: m.url, type: m.type === "video" ? "video" : m.type === "image" ? "image" : inferMediaType(m.url) });
    }
    for (const url of Array.isArray(p.mediaUrls) ? p.mediaUrls : []) {
      if (typeof url !== "string" || !url.trim()) continue;
      media.push({ url: url.trim(), type: inferMediaType(url) });
    }
    for (const m of media) {
      if (!/^https?:\/\//i.test(m.url)) {
        throw new BadRequestException(`Media URL must be publicly reachable over http(s): ${m.url}`);
      }
    }

    // Disposition: draft | review | queue | scheduled | publish-now.
    const mode = (p.status || "").toString().toLowerCase();
    let saveAs: string | undefined;
    if (p.draft === true || mode === "draft") saveAs = "draft";
    else if (p.review === true || mode === "review" || mode === "pending_review") saveAs = "review";
    else if (p.addToQueue === true || mode === "queue" || mode === "queued") saveAs = "queue";
    else if (mode && !["publish", "publish_now", "scheduled", "schedule", ""].includes(mode)) {
      throw new BadRequestException(
        `Unknown 'status' "${p.status}". Use draft | review | queue | scheduled | publish_now (or omit).`,
      );
    }

    let scheduledFor = p.scheduledFor || null;
    if (scheduledFor) {
      const d = new Date(scheduledFor);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException("'scheduledFor' must be an ISO-8601 datetime, e.g. 2026-08-01T14:30:00Z.");
      }
      scheduledFor = d.toISOString();
    }
    // No explicit time and no special mode → publish immediately (the shared
    // pipeline treats anything inside the 10-minute window as publish-now).
    if (!scheduledFor && !saveAs) scheduledFor = new Date().toISOString();

    const result = await this.posts.create(
      {
        body: content,
        media,
        linkUrl: p.linkUrl || null,
        firstComment: p.firstComment || null,
        contentType: p.contentType || null,
        socialAccountIds: accountIds,
        scheduledFor,
        saveAs,
        // Optional per-platform overrides — sanitized/persisted by PostsService.
        platformCaptions: p.platformCaptions || null,
        platformOptions: p.platformOptions || null,
      },
      profile,
    );

    // Normalize both create() return shapes (draft/review vs scheduled/published).
    return {
      post: toApiPost({ ...result.post, post_targets: undefined }),
      results: (result as any).results || null,
      savedAs: (result as any).saved || (result.publishedNow ? "published" : saveAs === "queue" ? "queued" : "scheduled"),
      warning: (result as any).warning || null,
    };
  }

  // GET /api/v1/posts/:id
  async getPost(id: string) {
    const db = this.supabaseService.createServiceClient();
    const { data: post, error } = await db
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(id, display_name, platform))")
      .eq("id", id)
      .eq("user_id", OWNER_ID)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!post) throw new NotFoundException("Post not found.");
    return { post: toApiPost(post) };
  }

  // GET /api/v1/posts?limit=&status=
  async listPosts(query: any) {
    const limit = Math.min(Math.max(parseInt(query?.limit, 10) || 25, 1), 100);
    const status = (query?.status || "").trim();

    const db = this.supabaseService.createServiceClient();
    let q = db
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(id, display_name, platform))")
      .eq("user_id", OWNER_ID)
      .order("scheduled_for", { ascending: false })
      .limit(limit);
    if (status) q = q.eq("status", status);

    const { data, error } = await q;
    if (error) throw new InternalServerErrorException(error.message);
    return { posts: (data || []).map(toApiPost) };
  }

  // DELETE /api/v1/posts/:id — same semantics as deleting in the app.
  async deletePost(id: string) {
    return this.posts.remove(id);
  }

  // POST /api/v1/media — multipart file upload, or JSON { url } to mirror a
  // remote file into S3 (returns the public S3 URL to use in POST /v1/posts).
  async uploadMedia(file: any, body: any) {
    if (file) return this.upload.upload(file);

    const url = (body?.url || "").trim();
    if (!url) {
      throw new BadRequestException("Send a multipart 'file' field, or JSON { \"url\": \"https://…\" } to import.");
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException("'url' must be an http(s) URL.");
    }

    let res: any;
    try {
      res = await fetch(url);
    } catch (e: any) {
      throw new BadRequestException(`Could not fetch the URL: ${e.message}`);
    }
    if (!res.ok) throw new BadRequestException(`Could not fetch the URL (HTTP ${res.status}).`);

    const declaredLength = Number(res.headers.get("content-length") || 0);
    if (declaredLength > MAX_REMOTE_MEDIA_BYTES) {
      throw new BadRequestException("Remote file exceeds the 200 MB limit.");
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_REMOTE_MEDIA_BYTES) {
      throw new BadRequestException("Remote file exceeds the 200 MB limit.");
    }

    const nameFromUrl = decodeURIComponent(url.split("?")[0].split("/").pop() || "media");
    return this.upload.upload({
      originalname: nameFromUrl,
      mimetype: res.headers.get("content-type") || "application/octet-stream",
      buffer,
    });
  }
}
