import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { OWNER_ID } from "../../supabase/supabase.service";
import { StorageService } from "../../storage/storage.service";
import { optimizeImageBuffer } from "../../lib/imageOptimize";

// The extension an object should carry for a given content type.
//
// This exists because the platforms read the file type off the URL, not off the
// bytes or the Content-Type header S3 serves. Postiz is the strict one — it
// takes only .png/.jpg/.jpeg/.gif/.webp/.mp4 — so a browser-legal upload like
// .jfif (which IS jpeg data) was stored under its original name and then
// rejected at publish time, with an error that named neither the file nor the
// post. Three such files reached production before this.
//
// Only known types are rewritten. Anything else keeps its original name: the
// native YouTube/Facebook paths accept formats Postiz never will, and renaming
// a file we cannot identify would be a guess.
const CANONICAL_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

function withCanonicalExtension(name: string, mimeType: string): string {
  const want = CANONICAL_EXT[(mimeType || "").toLowerCase().split(";")[0].trim()];
  if (!want) return name;
  const current = (name.match(/\.([a-zA-Z0-9]+)$/) || [])[1];
  if (current && current.toLowerCase() === want) return name;
  // A name with no extension at all gets one too — four such files reached
  // production, and they fail exactly the same way.
  const stem = current ? name.replace(/\.[^.]+$/, "") : name;
  return `${stem || "file"}.${want}`;
}

@Injectable()
export class UploadService {
  constructor(private readonly storage: StorageService) {}

  // Uploads an image or video to S3 and returns a public HTTPS URL that the
  // social platforms can fetch when publishing.
  async upload(file: any) {
    if (!file) {
      throw new BadRequestException("No file provided.");
    }

    let buffer: Buffer = file.buffer;
    let mimeType = file.mimetype || "application/octet-stream";
    const originalName = file.originalname || "file";
    let safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "-");
    const originalSizeBytes = buffer.byteLength;
    let optimized = false;

    // Downscale/re-encode oversized images so platforms (esp. Facebook) don't
    // reject them with an opaque "Invalid parameter". No-op for in-limit
    // images, videos, GIFs and SVGs. Best-effort: fall back to the original on
    // any failure so a quirky image still uploads.
    try {
      const opt = await optimizeImageBuffer(buffer, mimeType);
      if (opt.changed) {
        buffer = opt.buffer;
        mimeType = opt.contentType;
        if (opt.ext) safeName = `${safeName.replace(/\.[^.]+$/, "")}.${opt.ext}`;
        optimized = true;
      }
    } catch (e: any) {
      console.warn("[upload] image optimize skipped:", e?.message);
    }

    // Last, so it also covers the optimizer's own re-encodes.
    safeName = withCanonicalExtension(safeName, mimeType);

    const key = `${OWNER_ID}/${Date.now()}-${safeName}`;
    const hash = createHash("sha256").update(buffer).digest("hex");

    const { url } = await this.storage.put(key, buffer, mimeType);

    return {
      url,
      storagePath: key,
      filename: safeName,
      mimeType,
      sizeBytes: buffer.byteLength,
      // `optimized` (+ the pre-optimization size) lets the UI tell the user the
      // image was auto-downscaled to fit the platforms' limits.
      optimized,
      originalSizeBytes,
      hash,
    };
  }
}
