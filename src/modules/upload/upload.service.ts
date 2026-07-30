import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { OWNER_ID } from "../../supabase/supabase.service";
import { StorageService } from "../../storage/storage.service";
import { optimizeImageBuffer } from "../../lib/imageOptimize";

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
