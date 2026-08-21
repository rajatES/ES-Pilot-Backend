// TypeORM entities — the application schema. Column names are snake_case to
// match the API data contract. DB_SYNC=true creates/alters tables from these
// definitions; switch to generated migrations once production data exists.

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";

// Status values shared by scheduled_posts and post_targets.
export type PostStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "scheduled"
  | "publishing"
  | "sent"
  | "failed"
  | "deleted";

// ── Users (replaces Supabase Auth + profiles) ────────────────────────────
// Password is bcrypt-hashed; api_key is the opaque session token handed to the
// browser (same model as the ES Studio backend).
@Entity("profiles")
export class Profile {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: "password_hash", nullable: true })
  password_hash: string;

  @Index()
  @Column({ name: "api_key", type: "text", unique: true, nullable: true })
  api_key: string;

  @Column({ name: "display_name" })
  display_name: string;

  @Column({ default: "member" })
  role: string; // 'admin' | 'member'

  @Index()
  @Column({ default: "active" })
  status: string; // 'active' | 'pending'

  @Column({ name: "is_group_head", default: false })
  is_group_head: boolean;

  @Index()
  @Column({ name: "division_id", type: "uuid", nullable: true })
  division_id: string | null;

  @Column({ name: "created_by", type: "uuid", nullable: true })
  created_by: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

@Entity("divisions")
export class Division {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true })
  name: string;

  // Display name only — a group head may not hold a login seat.
  @Column({ name: "group_head", type: "text", nullable: true })
  group_head: string | null;

  @Column({ name: "daily_target", type: "int", nullable: true })
  daily_target: number | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

// Sport / vertical taxonomy — the editable list behind the account "category"
// field. Seeded with the historical defaults on first read; admins add/remove
// entries from the Accounts hub. "Other" is a reserved fallback, never stored.
@Entity("sports")
export class Sport {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true })
  name: string;

  // Preserves the default ordering; custom entries append after the defaults.
  @Column({ name: "sort_order", type: "int", default: 0 })
  sort_order: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

// Reusable image-generation prompt templates ("Design Templates"). A shared
// library of parameterized prompts (with {placeholders}); seeded with defaults
// on first read. Separate from the text `templates` (caption/hashtag) feature.
@Entity("design_templates")
export class DesignTemplate {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({ type: "text" })
  prompt: string;

  @Column({ type: "text", array: true, default: () => "'{}'" })
  tags: string[];

  @Column({ name: "story_types", type: "text", array: true, default: () => "'{}'" })
  story_types: string[];

  // Stable key for seeded library items (e.g. "version_b"); null for custom ones.
  @Column({ name: "template_key", type: "text", nullable: true })
  template_key: string | null;

  @Column({ name: "is_default", default: false })
  is_default: boolean;

  @Column({ name: "created_by", type: "uuid", nullable: true })
  created_by: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updated_at: Date;
}

// ── Connected social accounts ────────────────────────────────────────────
@Entity("social_accounts")
@Unique(["user_id", "platform", "external_account_id"])
export class SocialAccount {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Column()
  platform: string; // facebook | instagram | threads | twitter | youtube

  // Which pipeline publishes to this account. "native" = our own Meta/X/Google
  // app + the token on this row. "postiz" = relayed through the Postiz API with
  // the workspace POSTIZ_API_KEY, for channels our apps can't reach (Threads,
  // personal/standalone Instagram) — there `external_account_id` is the Postiz
  // integration id, `access_token` stays null, and the Postiz provider
  // identifier lives in metadata.postiz.provider. `platform` is unaffected, so
  // the composer/previews/analytics treat these like any other account.
  @Column({ name: "publish_via", default: "native" })
  publish_via: string; // native | postiz

  @Column({ name: "account_type", default: "page" })
  account_type: string;

  @Column({ name: "external_account_id" })
  external_account_id: string;

  @Column({ name: "display_name" })
  display_name: string;

  @Column({ name: "avatar_url", type: "text", nullable: true })
  avatar_url: string | null;

  @Column({ name: "access_token", type: "text", nullable: true })
  access_token: string | null;

  @Column({ name: "refresh_token", type: "text", nullable: true })
  refresh_token: string | null;

  @Column({ name: "token_expires_at", type: "timestamptz", nullable: true })
  token_expires_at: Date | null;

  // connected_via (the FB account that granted the page), source, username…
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  metadata: Record<string, any>;

  @Column({ type: "text", nullable: true })
  category: string | null; // sport/vertical, used by the account filters

  @Column({ name: "business_name", type: "text", nullable: true })
  business_name: string | null;

  @Column({ type: "int", nullable: true })
  followers: number | null;

  @Column({ name: "page_likes", type: "int", nullable: true })
  page_likes: number | null;

  @Column({ type: "text", array: true, nullable: true })
  permissions: string[] | null;

  @Column({ name: "publishing_ok", default: true })
  publishing_ok: boolean;

  @Column({ name: "last_synced_at", type: "timestamptz", nullable: true })
  last_synced_at: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updated_at: Date;
}

// ── Posts ────────────────────────────────────────────────────────────────
export type PostMedia = { url: string; type: "image" | "video" };

@Entity("scheduled_posts")
export class ScheduledPost {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Column({ type: "text" })
  body: string;

  // First image — kept alongside media[] for calendar/queue thumbnails.
  @Column({ name: "image_url", type: "text", nullable: true })
  image_url: string | null;

  // Ordered [{url, type}] — one video OR up to N images, per platform rules.
  @Column({ type: "jsonb", nullable: true })
  media: PostMedia[] | null;

  @Column({ name: "link_url", type: "text", nullable: true })
  link_url: string | null;

  @Index()
  @Column({ name: "scheduled_for", type: "timestamptz" })
  scheduled_for: Date;

  @Index()
  @Column({ default: "scheduled" })
  status: PostStatus;

  @Column({ name: "last_error", type: "text", nullable: true })
  last_error: string | null;

  @Column({ name: "sent_at", type: "timestamptz", nullable: true })
  sent_at: Date | null;

  @Column({ name: "campaign_id", type: "uuid", nullable: true })
  campaign_id: string | null;

  @Column({ name: "template_id", type: "uuid", nullable: true })
  template_id: string | null;

  @Column({ name: "first_comment", type: "text", nullable: true })
  first_comment: string | null;

  // Per-platform caption overrides: { facebook?: string, instagram?: … }.
  // Null/missing platform → falls back to `body` (lib/postContent.js).
  @Column({ name: "platform_captions", type: "jsonb", nullable: true })
  platform_captions: Record<string, string> | null;

  // Per-platform publish options: { facebook?: { format: "post"|"reel"|"story" },
  // instagram?: { format: "feed"|"reel" }, youtube?: { title?, privacy? } }.
  @Column({ name: "platform_options", type: "jsonb", nullable: true })
  platform_options: Record<string, any> | null;

  @Column({ name: "content_type", type: "text", nullable: true })
  content_type: string | null;

  @Column({ type: "jsonb", nullable: true })
  recurrence: Record<string, any> | null;

  @Column({ name: "approval_status", type: "text", default: "none" })
  approval_status: string; // none | pending | approved | rejected

  // Optional fact-check verdict attached at approval time when the gate is on:
  // { action: "pass"|"flag"|"block", reason, verdict, mode, checked, at }.
  // Null when the gate is off or the post was never reviewed.
  @Column({ name: "fact_check", type: "jsonb", nullable: true })
  fact_check: Record<string, any> | null;

  // When set (and auto-approve is enabled), the auto-approve cron approves this
  // pending_review post once this time passes, unless a human acts first.
  @Column({ name: "auto_approve_at", type: "timestamptz", nullable: true })
  auto_approve_at: Date | null;

  // How this post entered the system: "app" (composer, the default), "api"
  // (external Developer API /api/v1), "csv" (bulk import), or "recycle" (clone).
  // Powers the API Activity view and per-key usage tracking.
  @Index()
  @Column({ name: "source", type: "text", default: "app" })
  source: string;

  // When source = "api", the Developer API key (api_keys.id) that created this
  // post — resolved to a name in the UI. Null for every non-API source.
  @Index()
  @Column({ name: "api_key_id", type: "uuid", nullable: true })
  api_key_id: string | null;

  @Column({ name: "created_by", type: "uuid", nullable: true })
  created_by: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updated_at: Date;
}

@Entity("post_targets")
@Unique(["post_id", "social_account_id"])
export class PostTarget {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "post_id", type: "uuid" })
  post_id: string;

  @Index()
  @Column({ name: "social_account_id", type: "uuid" })
  social_account_id: string;

  @Column()
  platform: string;

  @Index()
  @Column({ default: "scheduled" })
  status: PostStatus;

  @Column({ name: "external_post_id", type: "text", nullable: true })
  external_post_id: string | null;

  @Column({ name: "last_error", type: "text", nullable: true })
  last_error: string | null;

  @Column({ name: "sent_at", type: "timestamptz", nullable: true })
  sent_at: Date | null;

  // Per-page approval audit: who approved/rejected THIS page's copy, and when.
  // Enables independent per-page review (a post can be approved for one page
  // while another still waits).
  @Column({ name: "reviewed_by", type: "uuid", nullable: true })
  reviewed_by: string | null;

  @Column({ name: "reviewed_at", type: "timestamptz", nullable: true })
  reviewed_at: Date | null;

  @Column({ name: "last_verified_at", type: "timestamptz", nullable: true })
  last_verified_at: Date | null;

  @Column({ name: "deleted_at", type: "timestamptz", nullable: true })
  deleted_at: Date | null;

  // Public URL of the published post, when the platform gives us one. Native
  // Facebook/X/YouTube permalinks are derived from the id (frontend fbLink.js),
  // but Instagram and Threads media ids have no derivable URL — Postiz returns
  // one as `releaseURL`, so postiz-backed targets store it here and the View
  // button finally works for them.
  @Column({ type: "text", nullable: true })
  permalink: string | null;

  // sha1 of the last remote caption we saw — lets the sync cron detect an
  // externally-edited post exactly once.
  @Column({ name: "remote_message_hash", type: "text", nullable: true })
  remote_message_hash: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

@Entity("post_insights")
export class PostInsight {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "post_target_id", type: "uuid", nullable: true })
  post_target_id: string | null;

  @Column({ name: "external_post_id", type: "text", nullable: true })
  external_post_id: string | null;

  @Column({ type: "text", nullable: true })
  platform: string | null;

  @Column({ type: "int", nullable: true }) reach: number | null;
  @Column({ type: "int", nullable: true }) impressions: number | null;
  @Column({ type: "int", nullable: true }) likes: number | null;
  @Column({ type: "int", nullable: true }) comments: number | null;
  @Column({ type: "int", nullable: true }) shares: number | null;
  @Column({ type: "int", nullable: true }) reactions: number | null;
  @Column({ type: "int", nullable: true }) clicks: number | null; // link/post clicks
  @Column({ name: "video_views", type: "int", nullable: true }) video_views: number | null;

  // Detailed per-post metrics for the Post Analytics table. All nullable — a
  // metric a platform doesn't expose stays null and renders as "N/A".
  @Column({ type: "int", nullable: true }) saves: number | null; // IG saved
  @Column({ name: "total_interactions", type: "int", nullable: true }) total_interactions: number | null;
  @Column({ name: "three_second_views", type: "int", nullable: true }) three_second_views: number | null;
  @Column({ name: "video_watch_time", type: "bigint", nullable: true }) video_watch_time: number | null; // seconds, total
  @Column({ name: "video_avg_time", type: "numeric", nullable: true }) video_avg_time: number | null; // seconds, per view
  @Column({ type: "int", nullable: true }) viewers: number | null; // unique viewers (≈ reach on FB)
  @Column({ type: "int", nullable: true }) follows: number | null; // follows attributed to the post
  @Column({ type: "int", nullable: true }) replies: number | null; // Threads/X replies

  @Column({ name: "engagement_rate", type: "numeric", nullable: true })
  engagement_rate: number | null;

  @CreateDateColumn({ name: "fetched_at", type: "timestamptz" })
  fetched_at: Date;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  raw: Record<string, any>;
}

// ── Synced page content ──────────────────────────────────────────────────
// Every real post on a connected page/account, pulled from the platform's
// Graph edge (not just posts published through this app). Powers the "all
// posts" mode of Post Analytics. Metrics live on the row (refreshed by sync).
@Entity("social_posts")
@Unique(["social_account_id", "external_post_id"])
export class SocialPost {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "social_account_id", type: "uuid" })
  social_account_id: string;

  @Column()
  platform: string;

  @Index()
  @Column({ name: "external_post_id", type: "text" })
  external_post_id: string;

  @Column({ name: "post_type", type: "text", nullable: true })
  post_type: string | null; // photo | video | link | status | reel | story | carousel

  @Column({ type: "text", nullable: true })
  message: string | null;

  @Column({ name: "media_url", type: "text", nullable: true })
  media_url: string | null;

  @Column({ name: "thumbnail_url", type: "text", nullable: true })
  thumbnail_url: string | null;

  @Column({ type: "text", nullable: true })
  permalink: string | null;

  @Index()
  @Column({ name: "posted_at", type: "timestamptz", nullable: true })
  posted_at: Date | null;

  @Column({ name: "is_published", default: true })
  is_published: boolean;

  @Column({ name: "author_name", type: "text", nullable: true })
  author_name: string | null;

  @Column({ type: "int", nullable: true }) likes: number | null;
  @Column({ type: "int", nullable: true }) comments: number | null;
  @Column({ type: "int", nullable: true }) shares: number | null;
  @Column({ type: "int", nullable: true }) reach: number | null;
  @Column({ type: "int", nullable: true }) impressions: number | null; // views
  @Column({ type: "int", nullable: true }) viewers: number | null;
  @Column({ type: "int", nullable: true }) saves: number | null;
  @Column({ type: "int", nullable: true }) clicks: number | null;
  @Column({ name: "total_interactions", type: "int", nullable: true }) total_interactions: number | null;
  @Column({ name: "three_second_views", type: "int", nullable: true }) three_second_views: number | null;
  @Column({ name: "video_watch_time", type: "bigint", nullable: true }) video_watch_time: number | null;
  @Column({ name: "video_avg_time", type: "numeric", nullable: true }) video_avg_time: number | null;
  @Column({ type: "int", nullable: true }) replies: number | null;
  @Column({ type: "int", nullable: true }) follows: number | null;

  @Column({ name: "fetched_at", type: "timestamptz", nullable: true })
  fetched_at: Date | null;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  raw: Record<string, any>;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updated_at: Date;
}

// ── Posting queues (weekly time slots per account) ───────────────────────
@Entity("posting_slots")
@Unique(["social_account_id", "weekday", "time_of_day"])
export class PostingSlot {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Index()
  @Column({ name: "social_account_id", type: "uuid" })
  social_account_id: string;

  @Column({ type: "smallint" })
  weekday: number; // 0 = Sunday

  @Column({ name: "time_of_day", type: "time" })
  time_of_day: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

// ── Content library ──────────────────────────────────────────────────────
@Entity("templates")
export class Template {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Column()
  kind: string;

  @Column()
  name: string;

  @Column({ type: "text", nullable: true })
  content: string | null;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  data: Record<string, any>;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updated_at: Date;
}

@Entity("media_folders")
export class MediaFolder {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Column()
  name: string;

  @Column({ name: "parent_id", type: "uuid", nullable: true })
  parent_id: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

@Entity("media_assets")
export class MediaAsset {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Column({ name: "folder_id", type: "uuid", nullable: true })
  folder_id: string | null;

  @Column({ type: "text" })
  url: string;

  // S3 object key — needed to delete the object when the asset is removed.
  @Column({ name: "storage_path", type: "text", nullable: true })
  storage_path: string | null;

  @Column({ type: "text", nullable: true }) filename: string | null;
  @Column({ name: "mime_type", type: "text", nullable: true }) mime_type: string | null;
  @Column({ name: "size_bytes", type: "bigint", nullable: true }) size_bytes: number | null;
  @Column({ type: "int", nullable: true }) width: number | null;
  @Column({ type: "int", nullable: true }) height: number | null;
  @Column({ type: "text", nullable: true }) hash: string | null;

  @Column({ type: "text", array: true, default: () => "'{}'" })
  tags: string[];

  @Column({ name: "is_favorite", default: false })
  is_favorite: boolean;

  @Column({ type: "text", default: "upload" })
  source: string;

  @Column({ name: "used_count", type: "int", default: 0 })
  used_count: number;

  @Column({ name: "last_used_at", type: "timestamptz", nullable: true })
  last_used_at: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

// ── Workflow / ops ───────────────────────────────────────────────────────
@Entity("approvals")
export class Approval {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "post_id", type: "uuid", nullable: true })
  post_id: string | null;

  @Column()
  action: string;

  @Column({ type: "text", nullable: true }) reviewer: string | null;
  @Column({ type: "text", nullable: true }) comment: string | null;

  // First-class audit: the profile that acted (WHO), and the specific page this
  // action was for on a per-page approval (null = whole-post action). `reviewer`
  // is kept as the display-name for easy rendering.
  @Column({ name: "approver_id", type: "uuid", nullable: true }) approver_id: string | null;
  @Column({ name: "social_account_id", type: "uuid", nullable: true }) social_account_id: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

@Entity("activity_log")
export class ActivityLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Column() type: string;
  @Column() title: string;
  @Column({ default: "info" }) status: string;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  meta: Record<string, any>;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

@Entity("notifications")
export class Notification {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Column() type: string;
  @Column() title: string;
  @Column({ type: "text", nullable: true }) body: string | null;
  @Column({ type: "text", default: "info" }) severity: string;
  @Column({ default: false }) read: boolean;
  @Column({ type: "text", nullable: true }) link: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

@Entity("app_settings")
@Unique(["user_id", "key"])
export class AppSetting {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Column()
  key: string;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  value: Record<string, any>;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updated_at: Date;
}

@Entity("user_integrations")
@Unique(["profile_id", "provider"])
export class UserIntegration {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "profile_id", type: "uuid" })
  profile_id: string;

  @Column()
  provider: string; // canva | google …

  @Column({ name: "access_token", type: "text", nullable: true })
  access_token: string | null;

  @Column({ name: "refresh_token", type: "text", nullable: true })
  refresh_token: string | null;

  @Column({ name: "expires_at", type: "timestamptz", nullable: true })
  expires_at: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updated_at: Date;
}

@Entity("campaigns")
export class Campaign {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Column() name: string;
  @Column({ type: "text", nullable: true }) description: string | null;
  @Column({ type: "text", default: "#2864d8" }) color: string;

  @Column({ name: "starts_at", type: "timestamptz", nullable: true }) starts_at: Date | null;
  @Column({ name: "ends_at", type: "timestamptz", nullable: true }) ends_at: Date | null;
  @Column({ default: "active" }) status: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

// ── Developer API keys (external integrations) ──────────────────────────
// Full key is shown once at creation and stored only as a sha256 hash;
// key_prefix (e.g. "pp_live_3f9a…") is kept for display in Settings.
@Entity("api_keys")
export class ApiKey {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string; // human label, e.g. "n8n automation"

  @Index({ unique: true })
  @Column({ name: "key_hash", type: "text" })
  key_hash: string;

  @Column({ name: "key_prefix", type: "text" })
  key_prefix: string;

  @Index()
  @Column({ name: "created_by", type: "uuid", nullable: true })
  created_by: string | null;

  @Column({ name: "last_used_at", type: "timestamptz", nullable: true })
  last_used_at: Date | null;

  @Column({ name: "revoked_at", type: "timestamptz", nullable: true })
  revoked_at: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

// ── Developer API idempotency claims ─────────────────────────────────────
// One row per `Idempotency-Key` seen on POST /api/v1/posts. The unique index on
// (user_id, idempotency_key) is what actually prevents a duplicate post: a
// retried or double-fired automation request loses the race on INSERT instead
// of creating a second post. `post_id` is filled in once the post exists, so a
// replay can return the original; a claim with a null `post_id` means the first
// request is still in flight.
@Entity("api_idempotency")
@Unique(["user_id", "idempotency_key"])
export class ApiIdempotency {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "user_id", type: "uuid" })
  user_id: string;

  @Column({ name: "idempotency_key", type: "text" })
  idempotency_key: string;

  @Column({ name: "api_key_id", type: "uuid", nullable: true })
  api_key_id: string | null;

  @Column({ name: "post_id", type: "uuid", nullable: true })
  post_id: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;
}

// ── Automation config (per connected account) ────────────────────────────
// The editorial brief a content automation needs in order to write FOR a page:
// which entities it covers, where it listens, how its captions sound, what its
// cards look like, how much it may post. Pilot already owns page IDENTITY and
// HEALTH; this is the layer that says what the page is ABOUT.
//
// Added 2026-08-06 to retire the ES Facebook automation's S3 page registry
// (`config/page-registry/*.json`). That registry held exactly these fields plus
// a Facebook page id it never actually populated — 0 of 22 rows had one — while
// Pilot has had the real `external_account_id` all along. Folding the config in
// here makes one record the whole truth about a page instead of two that have to
// be joined on an id one side was missing.
//
// A SEPARATE TABLE rather than more `social_accounts.metadata` jsonb: that column
// already carries `connected_via` and `auth_error`, both written by the publish
// path on failure. Editorial config is edited by people on a completely different
// cadence, and a jsonb merge racing an auth-error write is a real way to lose one
// of them. Different writers, different lifetimes, different table.
//
// Every field is nullable/defaulted. A row that exists but is half-filled is the
// normal state while a page is being set up, and the consumer's own defaults
// (see `computeDailyBudget`) cover the gaps.
@Entity("account_automation_config")
@Unique(["social_account_id"])
export class AccountAutomationConfig {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "social_account_id", type: "uuid" })
  social_account_id: string;

  // Legacy correlation id (`p02`, `p14`…). NOT decorative: the automation's S3
  // pool artefacts, ledger rows and dedup keys are all keyed on it, and the
  // legacy Claude routine still writes the same keys while both run in parallel.
  // Retire it only after cutover, when nothing reads those keys any more.
  @Index()
  @Column({ name: "es_page_id", type: "text", nullable: true })
  es_page_id: string | null;

  // Master switch. FALSE by default so that creating a row — or connecting a new
  // page — can never by itself put a page into an automation's rotation. Opting
  // in is always a deliberate edit.
  @Column({ name: "automation_enabled", type: "boolean", default: false })
  automation_enabled: boolean;

  // `light` pins the page to its declared wave_slots, `semi` to a fixed daily
  // count, `full` to a min/max band. See the consumer's computeDailyBudget.
  @Column({ name: "automation_level", type: "text", default: "light" })
  automation_level: string;

  // ── What the page is about ─────────────────────────────────────────────
  // sport_groups is an ARRAY and deliberately not social_accounts.category:
  // category is a single string driving Pilot's own UI filters, while a page
  // like "WNBA/NCAA" legitimately covers several. Two different questions.
  @Column({ name: "sport_groups", type: "jsonb", default: () => "'[]'::jsonb" })
  sport_groups: string[];

  // [{ name, keywords[], weight }] — weight biases how often each gets a slot.
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  entities: Array<{ name: string; keywords?: string[]; weight?: number }>;

  @Column({ name: "rival_entities", type: "jsonb", default: () => "'[]'::jsonb" })
  rival_entities: string[];

  @Column({ name: "page_theme", type: "text", nullable: true })
  page_theme: string | null;

  // Free text, read by the editorial prompt. E.g. a deceased figure who may only
  // be covered in tribute framing.
  @Column({ type: "text", nullable: true })
  sensitivities: string | null;

  @Column({ name: "national_threshold", type: "int", nullable: true })
  national_threshold: number | null;

  // ── Where it listens ───────────────────────────────────────────────────
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  subreddits: string[];

  @Column({ name: "twitter_handles", type: "jsonb", default: () => "'[]'::jsonb" })
  twitter_handles: string[];

  @Column({ name: "external_feed_urls", type: "jsonb", default: () => "'[]'::jsonb" })
  external_feed_urls: string[];

  // ── How its captions sound ─────────────────────────────────────────────
  @Column({ name: "caption_voice", type: "text", nullable: true })
  caption_voice: string | null;

  @Column({ name: "word_count_min", type: "int", nullable: true })
  word_count_min: number | null;

  @Column({ name: "word_count_max", type: "int", nullable: true })
  word_count_max: number | null;

  @Column({ name: "emoji_count_min", type: "int", nullable: true })
  emoji_count_min: number | null;

  @Column({ name: "emoji_count_max", type: "int", nullable: true })
  emoji_count_max: number | null;

  @Column({ name: "case_rule", type: "text", nullable: true })
  case_rule: string | null;

  @Column({ type: "boolean", nullable: true })
  hashtags: boolean | null;

  // Terms that take a candidate out of contention for THIS page specifically —
  // distinct from the global blocked-terms list.
  @Column({ name: "hard_skip_keywords", type: "jsonb", default: () => "'[]'::jsonb" })
  hard_skip_keywords: string[];

  @Column({ name: "british_english", type: "boolean", default: false })
  british_english: boolean;

  // ── What its cards look like ───────────────────────────────────────────
  @Column({ name: "accent_hex", type: "text", nullable: true })
  accent_hex: string | null;

  @Column({ name: "accent2_hex", type: "text", nullable: true })
  accent2_hex: string | null;

  @Column({ name: "logo_mode", type: "text", nullable: true })
  logo_mode: string | null;

  // ── How much it may post ───────────────────────────────────────────────
  // "HH:MM" strings, page-local posting waves.
  @Column({ name: "wave_slots", type: "jsonb", default: () => "'[]'::jsonb" })
  wave_slots: string[];

  @Column({ name: "posting_window_start", type: "text", nullable: true })
  posting_window_start: string | null;

  @Column({ name: "posting_window_end", type: "text", nullable: true })
  posting_window_end: string | null;

  @Column({ name: "daily_budget_fixed", type: "int", nullable: true })
  daily_budget_fixed: number | null;

  @Column({ name: "daily_budget_min", type: "int", nullable: true })
  daily_budget_min: number | null;

  @Column({ name: "daily_budget_max", type: "int", nullable: true })
  daily_budget_max: number | null;

  // ── Tracking ───────────────────────────────────────────────────────────
  @Column({ name: "utm_params", type: "jsonb", default: () => "'{}'::jsonb" })
  utm_params: Record<string, string>;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  created_at: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updated_at: Date;
}

export const ALL_ENTITIES = [
  Profile,
  AccountAutomationConfig,
  Division,
  Sport,
  DesignTemplate,
  SocialAccount,
  ScheduledPost,
  PostTarget,
  PostInsight,
  SocialPost,
  PostingSlot,
  Template,
  MediaFolder,
  MediaAsset,
  Approval,
  ActivityLog,
  Notification,
  AppSetting,
  UserIntegration,
  Campaign,
  ApiKey,
  ApiIdempotency,
];
