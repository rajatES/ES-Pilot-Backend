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

  @Column({ name: "content_type", type: "text", nullable: true })
  content_type: string | null;

  @Column({ type: "jsonb", nullable: true })
  recurrence: Record<string, any> | null;

  @Column({ name: "approval_status", type: "text", default: "none" })
  approval_status: string; // none | pending | approved | rejected

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

  @Column({ name: "last_verified_at", type: "timestamptz", nullable: true })
  last_verified_at: Date | null;

  @Column({ name: "deleted_at", type: "timestamptz", nullable: true })
  deleted_at: Date | null;

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
  @Column({ type: "int", nullable: true }) clicks: number | null;
  @Column({ name: "video_views", type: "int", nullable: true }) video_views: number | null;

  @Column({ name: "engagement_rate", type: "numeric", nullable: true })
  engagement_rate: number | null;

  @CreateDateColumn({ name: "fetched_at", type: "timestamptz" })
  fetched_at: Date;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  raw: Record<string, any>;
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

export const ALL_ENTITIES = [
  Profile,
  Division,
  SocialAccount,
  ScheduledPost,
  PostTarget,
  PostInsight,
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
];
