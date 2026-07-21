import { BadRequestException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import os from "os";
import Tesseract from "tesseract.js";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { RULES } from "../../lib/compliance";
import { mentionsSportsEntity } from "../../lib/sportsEntities";

// Image-text rules: skip the ones that only make sense for the caption body.
const SKIP_RULE_IDS = new Set(["not-empty", "max-length", "link-https", "requires-image"]);
const TEXT_RULES = RULES.filter((r: any) => !SKIP_RULE_IDS.has(r.id));

// Live-check windows.
const CADENCE_WINDOW_MS = 15 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set(["scheduled", "publishing", "sent", "pending_review", "approved"]);

@Injectable()
export class ComplianceService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // Free local OCR compliance scan (Tesseract.js). Accepts { imageUrl } or { imageBase64 }.
  async image(payload: any) {
    const { imageUrl, imageBase64 } = payload || {};
    if (!imageUrl && !imageBase64) {
      throw new BadRequestException("imageUrl or imageBase64 is required.");
    }

    let buffer;
    try {
      if (imageBase64) {
        buffer = Buffer.from(imageBase64, "base64");
      } else {
        const res = await fetch(imageUrl);
        if (!res.ok) throw new Error(`Couldn't fetch image (${res.status}).`);
        buffer = Buffer.from(await res.arrayBuffer());
      }
    } catch (err) {
      throw new HttpException(`Image scan failed: ${err.message}`, HttpStatus.BAD_GATEWAY);
    }

    let extractedText = "";
    try {
      // Race OCR against a 3-second hard cap — a slow scan beats blocking the user.
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("OCR_TIMEOUT")), 3000));
      const ocr = Tesseract.recognize(buffer, "eng", { cachePath: os.tmpdir() });
      const { data } = (await Promise.race([ocr, timeout])) as any;
      extractedText = data.text || "";
    } catch (err) {
      if (err.message === "OCR_TIMEOUT") {
        return { flags: [], timedOut: true };
      }
      console.error("[compliance/image] OCR failed:", err.message);
      throw new HttpException(`Image scan failed: ${err.message}`, HttpStatus.BAD_GATEWAY);
    }

    const trimmed = extractedText.trim();
    const flags: any[] = [];
    for (const rule of TEXT_RULES) {
      let hit = false;
      try {
        hit = rule.test({ body: trimmed });
      } catch (e) {
        console.warn(`[compliance/image] rule "${rule.id}" threw:`, e.message);
      }
      if (!hit) continue;
      flags.push({ severity: rule.severity, label: `Image text: ${rule.label}`, message: rule.message });
    }

    if (trimmed && !mentionsSportsEntity(trimmed)) {
      flags.push({
        severity: "HIGH",
        label: "Image text: no recognized sports entity or personality",
        message:
          "The image has text on it, but none of it names a recognized sports entity, league, or personality.",
      });
    }

    return { flags, ocrText: trimmed || undefined };
  }

  // Live, data-backed checks (cadence collision + duplicate caption).
  async liveCheck(payload: any) {
    const { body, accountIds, scheduledFor } = payload || {};
    const ids = Array.isArray(accountIds) ? accountIds.filter(Boolean) : [];
    if (!ids.length) return { flags: [] };

    const when = scheduledFor ? new Date(scheduledFor) : new Date();
    if (Number.isNaN(when.getTime())) return { flags: [] };

    const supabase = this.supabaseService.createServiceClient();
    const { data: targets, error } = await supabase
      .from("post_targets")
      .select(
        "social_account_id, social_accounts(display_name), scheduled_posts(id, body, scheduled_for, status, user_id)",
      )
      .in("social_account_id", ids)
      .limit(500);
    if (error) return { flags: [] };

    const trimmedBody = (body || "").trim().toLowerCase();
    const windowStart = when.getTime() - CADENCE_WINDOW_MS;
    const windowEnd = when.getTime() + CADENCE_WINDOW_MS;
    const since = when.getTime() - DUPLICATE_WINDOW_MS;

    const flags: any[] = [];
    const seenCadence = new Set();
    const seenDuplicate = new Set();

    for (const row of targets || []) {
      const post: any = row.scheduled_posts;
      if (!post || post.user_id !== OWNER_ID || !ACTIVE_STATUSES.has(post.status)) continue;
      const pageName = (row.social_accounts as any)?.display_name || "This page";
      const postWhen = new Date(post.scheduled_for).getTime();

      if (postWhen >= windowStart && postWhen <= windowEnd && !seenCadence.has(pageName)) {
        seenCadence.add(pageName);
        flags.push({
          severity: "MED",
          label: "Posting-cadence collision",
          message: `${pageName} already has another post scheduled within 15 minutes of this time — consider spacing them out.`,
        });
      }

      if (
        trimmedBody &&
        post.body?.trim().toLowerCase() === trimmedBody &&
        postWhen >= since &&
        !seenDuplicate.has(pageName)
      ) {
        seenDuplicate.add(pageName);
        flags.push({
          severity: "MED",
          label: "Duplicate caption",
          message: `This exact caption was already posted/queued to ${pageName} in the last 7 days.`,
        });
      }
    }

    return { flags };
  }
}
