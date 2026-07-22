import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { OWNER_ID } from "../../supabase/supabase.service";
import { StorageService } from "../../storage/storage.service";

@Injectable()
export class UploadService {
  constructor(private readonly storage: StorageService) {}

  // Uploads an image or video to S3 and returns a public HTTPS URL that the
  // social platforms can fetch when publishing.
  async upload(file: any) {
    if (!file) {
      throw new BadRequestException("No file provided.");
    }

    const originalName = file.originalname || "file";
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "-");
    const key = `${OWNER_ID}/${Date.now()}-${safeName}`;

    const buffer: Buffer = file.buffer;
    const hash = createHash("sha256").update(buffer).digest("hex");

    const { url } = await this.storage.put(key, buffer, file.mimetype || "application/octet-stream");

    return {
      url,
      storagePath: key,
      filename: safeName,
      mimeType: file.mimetype || "application/octet-stream",
      sizeBytes: buffer.byteLength,
      hash,
    };
  }
}
