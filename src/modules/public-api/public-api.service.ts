import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
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

// ── Automation config (account_automation_config) ────────────────────────
// The editorial brief a content automation needs to write FOR a page. Stored
// snake_case (the DB contract); served camelCase (the API contract), grouped so
// a human reading the JSON can tell voice settings from budget settings.

function shapeAutomation(row: any) {
  return {
    enabled: row.automation_enabled === true,
    level: row.automation_level || "light",
    esPageId: row.es_page_id ?? null,
    sportGroups: row.sport_groups || [],
    entities: row.entities || [],
    rivalEntities: row.rival_entities || [],
    pageTheme: row.page_theme ?? null,
    sensitivities: row.sensitivities ?? null,
    nationalThreshold: row.national_threshold ?? null,
    sources: {
      subreddits: row.subreddits || [],
      twitterHandles: row.twitter_handles || [],
      externalFeedUrls: row.external_feed_urls || [],
    },
    caption: {
      voice: row.caption_voice ?? null,
      wordCountMin: row.word_count_min ?? null,
      wordCountMax: row.word_count_max ?? null,
      emojiCountMin: row.emoji_count_min ?? null,
      emojiCountMax: row.emoji_count_max ?? null,
      caseRule: row.case_rule ?? null,
      hashtags: row.hashtags ?? null,
      hardSkipKeywords: row.hard_skip_keywords || [],
      britishEnglish: row.british_english === true,
    },
    card: {
      accentHex: row.accent_hex ?? null,
      accent2Hex: row.accent2_hex ?? null,
      logoMode: row.logo_mode ?? null,
    },
    budget: {
      waveSlots: row.wave_slots || [],
      postingWindowStart: row.posting_window_start ?? null,
      postingWindowEnd: row.posting_window_end ?? null,
      dailyFixed: row.daily_budget_fixed ?? null,
      dailyMin: row.daily_budget_min ?? null,
      dailyMax: row.daily_budget_max ?? null,
    },
    utmParams: row.utm_params || {},
    updatedAt: row.updated_at ?? null,
  };
}

const AUTOMATION_LEVELS = new Set(["light", "semi", "full"]);

function strArray(value: any, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException(`${field} must be an array of strings`);
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function intOrNull(value: any, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new BadRequestException(`${field} must be a number`);
  return Math.floor(n);
}

function strOrNull(value: any): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

// Accepts the camelCase API shape (grouped or flat) and returns DB columns.
// Validation is strict on the fields where a wrong value changes behaviour
// silently — `enabled` and `level` decide whether and how much a page posts —
// and permissive on free text, which no amount of checking here can validate.
function parseAutomation(body: any) {
  if (!body || typeof body !== "object") {
    throw new BadRequestException("Body must be an automation config object");
  }
  const caption = body.caption || {};
  const card = body.card || {};
  const budget = body.budget || {};
  const sources = body.sources || {};

  const level = body.level === undefined ? "light" : String(body.level);
  if (!AUTOMATION_LEVELS.has(level)) {
    throw new BadRequestException(`level must be one of: ${[...AUTOMATION_LEVELS].join(", ")}`);
  }
  // Only a literal `true` enables a page. A truthy string ("false" is truthy in
  // JS) must never be the reason a page starts posting.
  const enabled = body.enabled === true;

  const entities = body.entities === undefined || body.entities === null ? [] : body.entities;
  if (!Array.isArray(entities)) throw new BadRequestException("entities must be an array");
  const parsedEntities = entities.map((e: any, i: number) => {
    const name = strOrNull(e?.name);
    if (!name) throw new BadRequestException(`entities[${i}].name is required`);
    return {
      name,
      keywords: strArray(e?.keywords, `entities[${i}].keywords`),
      ...(e?.weight === undefined || e?.weight === null
        ? {}
        : { weight: intOrNull(e.weight, `entities[${i}].weight`) }),
    };
  });

  return {
    automation_enabled: enabled,
    automation_level: level,
    es_page_id: strOrNull(body.esPageId),
    sport_groups: strArray(body.sportGroups, "sportGroups"),
    entities: parsedEntities,
    rival_entities: strArray(body.rivalEntities, "rivalEntities"),
    page_theme: strOrNull(body.pageTheme),
    sensitivities: strOrNull(body.sensitivities),
    national_threshold: intOrNull(body.nationalThreshold, "nationalThreshold"),
    subreddits: strArray(sources.subreddits, "sources.subreddits"),
    twitter_handles: strArray(sources.twitterHandles, "sources.twitterHandles"),
    external_feed_urls: strArray(sources.externalFeedUrls, "sources.externalFeedUrls"),
    caption_voice: strOrNull(caption.voice),
    word_count_min: intOrNull(caption.wordCountMin, "caption.wordCountMin"),
    word_count_max: intOrNull(caption.wordCountMax, "caption.wordCountMax"),
    emoji_count_min: intOrNull(caption.emojiCountMin, "caption.emojiCountMin"),
    emoji_count_max: intOrNull(caption.emojiCountMax, "caption.emojiCountMax"),
    case_rule: strOrNull(caption.caseRule),
    hashtags: caption.hashtags === undefined || caption.hashtags === null ? null : caption.hashtags === true,
    hard_skip_keywords: strArray(caption.hardSkipKeywords, "caption.hardSkipKeywords"),
    british_english: caption.britishEnglish === true,
    accent_hex: strOrNull(card.accentHex),
    accent2_hex: strOrNull(card.accent2Hex),
    logo_mode: strOrNull(card.logoMode),
    wave_slots: strArray(budget.waveSlots, "budget.waveSlots"),
    posting_window_start: strOrNull(budget.postingWindowStart),
    posting_window_end: strOrNull(budget.postingWindowEnd),
    daily_budget_fixed: intOrNull(budget.dailyFixed, "budget.dailyFixed"),
    daily_budget_min: intOrNull(budget.dailyMin, "budget.dailyMin"),
    daily_budget_max: intOrNull(budget.dailyMax, "budget.dailyMax"),
    utm_params:
      body.utmParams && typeof body.utmParams === "object" && !Array.isArray(body.utmParams)
        ? body.utmParams
        : {},
  };
}

// Review decisions (approvals rows) in the shape automations consume. The
// reviewer's `comment` is the point: a rejection reason is the only signal that
// says WHY something was turned down, and an automation that can read it can
// stop producing that kind of post. Without it a caller only learns that its
// output was rejected, which is not actionable.
function toApiApproval(row: any) {
  return {
    action: row.action,
    reviewer: row.reviewer || null,
    comment: row.comment || null,
    accountId: row.social_account_id || null,
    at: row.created_at,
  };
}

// Public shape for a post row + its targets — never leaks tokens or hashes.
function toApiPost(post: any, approvals?: any[]) {
  return {
    id: post.id,
    content: post.body,
    media: post.media || (post.image_url ? [{ url: post.image_url, type: "image" }] : []),
    linkUrl: post.link_url,
    firstComment: post.first_comment,
    contentType: post.content_type,
    platformCaptions: post.platform_captions || null,
    platformOptions: post.platform_options || null,
    source: post.source || "app",
    status: post.status,
    approvalStatus: post.approval_status,
    autoApproveAt: post.auto_approve_at || null,
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
      // Per-page review audit — who resolved this page and when.
      reviewedBy: t.reviewed_by || null,
      reviewedAt: t.reviewed_at || null,
    })),
    ...(approvals ? { approvals: approvals.map(toApiApproval) } : {}),
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
  //
  // `status` is DERIVED, not selected: `social_accounts` has no status column
  // (see entities.ts — it carries `publishing_ok`, set by the publish-blocked
  // detection), and selecting a non-existent column made this endpoint fail
  // outright. Automations still need a publishability signal, and the honest
  // one is `publishing_ok`: a page whose token was revoked or whose permissions
  // lapsed is marked not-ok, and an automation must skip it rather than
  // discovering it at publish time. Token expiry counts too — a long-lived page
  // token with a past `token_expires_at` cannot publish either.
  async listAccounts(query: any = {}) {
    const db = this.supabaseService.createServiceClient();
    const { data, error } = await db
      .from("social_accounts")
      .select(
        "id, platform, display_name, external_account_id, publishing_ok, token_expires_at, category, metadata, created_at",
      )
      .eq("user_id", OWNER_ID)
      .order("created_at", { ascending: false });
    if (error) throw new InternalServerErrorException(error.message);

    // `?include=automation` attaches each account's automation config. Opt-in
    // rather than always-on: it roughly doubles the payload, and the only
    // consumer that needs it is a content automation, not the app UI.
    const wantAutomation = String(query?.include || "")
      .split(",")
      .map((s: string) => s.trim())
      .includes("automation");

    // `?automationEnabled=true` returns only opted-in pages. The point is that a
    // consumer asking "which pages do I run for?" gets ONE list it can trust,
    // instead of fetching all 120-odd accounts and filtering client-side — where
    // forgetting the filter silently means running for every page in the
    // workspace.
    const enabledOnly = String(query?.automationEnabled || "") === "true";

    let configs = new Map<string, any>();
    if (wantAutomation || enabledOnly) {
      const { data: rows, error: cfgError } = await db
        .from("account_automation_config")
        .select("*");
      if (cfgError) throw new InternalServerErrorException(cfgError.message);
      configs = new Map((rows || []).map((r: any) => [r.social_account_id, r]));
    }

    const now = Date.now();
    let accounts = (data || []).map((a: any) => {
      const expired = a.token_expires_at ? new Date(a.token_expires_at).getTime() < now : false;
      const config = configs.get(a.id) || null;
      return {
        id: a.id,
        platform: a.platform,
        name: a.display_name,
        externalAccountId: a.external_account_id,
        status: a.publishing_ok === false || expired ? "blocked" : "active",
        publishingOk: a.publishing_ok !== false,
        tokenExpiresAt: a.token_expires_at || null,
        category: a.category,
        // Caller-owned correlation id. Read from the automation config first —
        // that is where it now lives — then from metadata, which is where the
        // earlier design put it. Null when unset in both.
        externalRefId: config?.es_page_id ?? a.metadata?.es_page_id ?? null,
        ...(wantAutomation || enabledOnly
          ? { automation: config ? shapeAutomation(config) : null }
          : {}),
      };
    });

    if (enabledOnly) {
      accounts = accounts.filter((a: any) => a.automation?.enabled === true);
    }
    return { accounts };
  }

  // GET /api/v1/accounts/:id/automation
  async getAutomation(id: string) {
    const db = this.supabaseService.createServiceClient();
    const { data: account } = await db
      .from("social_accounts")
      .select("id")
      .eq("id", id)
      .eq("user_id", OWNER_ID)
      .maybeSingle();
    if (!account) throw new NotFoundException("Account not found");

    const { data } = await db
      .from("account_automation_config")
      .select("*")
      .eq("social_account_id", id)
      .maybeSingle();
    // A page with no config is a normal state, not an error — it simply has not
    // been set up for automation yet. Returning null says that plainly.
    return { automation: data ? shapeAutomation(data) : null };
  }

  // PUT /api/v1/accounts/:id/automation — create or replace the config.
  //
  // Deliberately a full replace rather than a merge: this record is edited by
  // humans a field at a time, and a merge-on-write makes "I removed that entity"
  // indistinguishable from "I didn't mention that entity". Send the whole object.
  async putAutomation(id: string, body: any) {
    const db = this.supabaseService.createServiceClient();
    const { data: account } = await db
      .from("social_accounts")
      .select("id")
      .eq("id", id)
      .eq("user_id", OWNER_ID)
      .maybeSingle();
    if (!account) throw new NotFoundException("Account not found");

    const payload = { ...parseAutomation(body), social_account_id: id };
    const { data: existing } = await db
      .from("account_automation_config")
      .select("id")
      .eq("social_account_id", id)
      .maybeSingle();

    if (existing) {
      const { error } = await db
        .from("account_automation_config")
        .update(payload)
        .eq("id", existing.id);
      if (error) throw new InternalServerErrorException(error.message);
    } else {
      const { error } = await db.from("account_automation_config").insert(payload);
      if (error) throw new InternalServerErrorException(error.message);
    }
    return this.getAutomation(id);
  }

  // POST /api/v1/posts — create + publish/schedule/queue/review/draft.
  //
  // `idempotencyKey` (from the Idempotency-Key header) makes a retried request
  // safe: a network blip, a client-side retry, or two workers racing the same
  // job must not produce two live posts. The claim row is written BEFORE the
  // post, so the second caller loses on the unique index rather than
  // discovering the duplicate afterwards.
  async createPost(payload: any, profile: any, apiKey: any = null, idempotencyKey?: string) {
    const key = (idempotencyKey || "").trim();
    if (!key) return this.doCreatePost(payload, profile, apiKey);

    const db = this.supabaseService.createServiceClient();
    const { error: claimError } = await db.from("api_idempotency").insert({
      user_id: OWNER_ID,
      idempotency_key: key,
      api_key_id: apiKey?.id || null,
      post_id: null,
    });

    if (claimError) {
      // Someone already claimed this key. Either the original post exists (a
      // genuine replay — return it), or the first request is still running.
      const { data: existing } = await db
        .from("api_idempotency")
        .select("post_id")
        .eq("user_id", OWNER_ID)
        .eq("idempotency_key", key)
        .maybeSingle();
      if (!existing) {
        // The insert failed for some reason other than the unique index.
        throw new InternalServerErrorException(`Idempotency claim failed: ${claimError.message}`);
      }
      if (!existing.post_id) {
        throw new ConflictException(
          "A request with this Idempotency-Key is already in progress. Retry once it completes.",
        );
      }
      return { ...(await this.getPost(existing.post_id)), idempotentReplay: true };
    }

    try {
      const result = await this.doCreatePost(payload, profile, apiKey);
      await db
        .from("api_idempotency")
        .update({ post_id: result.post?.id || null })
        .eq("user_id", OWNER_ID)
        .eq("idempotency_key", key);
      return result;
    } catch (err) {
      // Release the claim so a corrected retry with the same key can proceed —
      // otherwise a validation error would poison that key permanently.
      await db.from("api_idempotency").delete().eq("user_id", OWNER_ID).eq("idempotency_key", key);
      throw err;
    }
  }

  private async doCreatePost(payload: any, profile: any, apiKey: any = null) {
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

    // Per-post auto-approve deadline. Only meaningful for a review submission:
    // an automation that scores its own output wants a high-confidence item to
    // clear in minutes and a borderline one to wait for a human, which one
    // global setting cannot express. Omitted → the shared window applies;
    // explicit null → manual review only, whatever the global setting says.
    let autoApproveAt: string | null | undefined;
    if (p.autoApproveAt !== undefined) {
      if (p.autoApproveAt === null) {
        autoApproveAt = null;
      } else {
        const at = new Date(p.autoApproveAt);
        if (Number.isNaN(at.getTime())) {
          throw new BadRequestException("'autoApproveAt' must be an ISO-8601 datetime or null.");
        }
        autoApproveAt = at.toISOString();
      }
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
        autoApproveAt,
        // Optional per-platform overrides — sanitized/persisted by PostsService.
        platformCaptions: p.platformCaptions || null,
        platformOptions: p.platformOptions || null,
        // Origin tracking — records that this post came in through the external
        // Developer API and which key created it (see PostsService.create).
        source: "api",
        apiKeyId: apiKey?.id || null,
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

  // GET /api/v1/posts/:id — includes the review decisions, so a caller can read
  // WHY a post was rejected rather than only that it was.
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

    const { data: approvals } = await db
      .from("approvals")
      .select("action, reviewer, comment, social_account_id, created_at")
      .eq("post_id", id)
      .order("created_at", { ascending: true });

    return { post: toApiPost(post, approvals || []) };
  }

  // GET /api/v1/posts?limit=&status=&approvalStatus=&source=&since=
  async listPosts(query: any) {
    const limit = Math.min(Math.max(parseInt(query?.limit, 10) || 25, 1), 100);
    const status = (query?.status || "").trim();
    // `status` and `approval_status` are different axes: a rejected post keeps a
    // lifecycle status of its own, so filtering rejections needs this second
    // filter. Without it there is no way to ask the API "what got turned down".
    const approvalStatus = (query?.approvalStatus || "").trim();
    const source = (query?.source || "").trim();
    const since = (query?.since || "").trim();

    const db = this.supabaseService.createServiceClient();
    let q = db
      .from("scheduled_posts")
      .select("*, post_targets(*, social_accounts(id, display_name, platform))")
      .eq("user_id", OWNER_ID)
      .order("scheduled_for", { ascending: false })
      .limit(limit);
    if (status) q = q.eq("status", status);
    if (approvalStatus) q = q.eq("approval_status", approvalStatus);
    if (source) q = q.eq("source", source);
    if (since) {
      const at = new Date(since);
      if (Number.isNaN(at.getTime())) {
        throw new BadRequestException("'since' must be an ISO-8601 datetime.");
      }
      q = q.gte("scheduled_for", at.toISOString());
    }

    const { data, error } = await q;
    if (error) throw new InternalServerErrorException(error.message);
    return { posts: (data || []).map((post: any) => toApiPost(post)) };
  }

  // GET /api/v1/accounts/:id/posts — EVERY post on a connected page, organic
  // and app-published alike, from the platform-sync table.
  //
  // This is the endpoint an automation needs to see what a page actually looks
  // like: what its human editors posted recently (the quality bar it should
  // match), what it has already covered (so it doesn't repeat a subject), and
  // what its captions have already said (so it doesn't ship a near-duplicate).
  // `GET /v1/posts` cannot answer any of that — it only knows about posts this
  // app created.
  //
  // `origin` is the load-bearing field: `app` marks a post this workspace
  // published (with `source` naming which surface — composer vs Developer API),
  // `organic` marks one that appeared on the page by other means. An automation
  // grading itself against its own past output learns nothing; it needs to know
  // which posts were human work.
  async listAccountPosts(accountId: string, query: any) {
    const limit = Math.min(Math.max(parseInt(query?.limit, 10) || 50, 1), 200);
    const since = (query?.since || "").trim();

    const db = this.supabaseService.createServiceClient();
    const { data: account } = await db
      .from("social_accounts")
      .select("id, display_name, platform")
      .eq("id", accountId)
      .eq("user_id", OWNER_ID)
      .maybeSingle();
    if (!account) throw new NotFoundException("Account not found — see GET /api/v1/accounts.");

    let q = db
      .from("social_posts")
      .select("*")
      .eq("social_account_id", accountId)
      .order("posted_at", { ascending: false })
      .limit(limit);
    if (since) {
      const at = new Date(since);
      if (Number.isNaN(at.getTime())) {
        throw new BadRequestException("'since' must be an ISO-8601 datetime.");
      }
      q = q.gte("posted_at", at.toISOString());
    }

    const { data, error } = await q;
    if (error) throw new InternalServerErrorException(error.message);
    const posts = data || [];

    // Provenance is resolved with a second query rather than a join: the two
    // tables are linked by the platform's own post id, not by a foreign key, so
    // the embedded-select shim cannot express it. Matching in memory over one
    // page of results is cheap and keeps the query layer untouched.
    const externalIds = posts.map((p: any) => p.external_post_id).filter(Boolean);
    const originByExternalId = new Map<string, string>();
    if (externalIds.length) {
      const { data: targets } = await db
        .from("post_targets")
        .select("external_post_id, scheduled_posts(source)")
        .eq("social_account_id", accountId)
        .in("external_post_id", externalIds);
      for (const t of targets || []) {
        if (t.external_post_id) {
          originByExternalId.set(t.external_post_id, t.scheduled_posts?.source || "app");
        }
      }
    }

    return {
      account: { id: account.id, name: account.display_name, platform: account.platform },
      posts: posts.map((p: any) => ({
        externalPostId: p.external_post_id,
        postType: p.post_type,
        message: p.message,
        mediaUrl: p.media_url,
        permalink: p.permalink,
        postedAt: p.posted_at,
        origin: originByExternalId.has(p.external_post_id) ? "app" : "organic",
        source: originByExternalId.get(p.external_post_id) || null,
        metrics: {
          likes: p.likes,
          comments: p.comments,
          shares: p.shares,
          reach: p.reach,
          impressions: p.impressions,
          totalInteractions: p.total_interactions,
        },
      })),
    };
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
