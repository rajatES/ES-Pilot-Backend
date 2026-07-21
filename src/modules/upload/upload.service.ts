import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { createHash } from "crypto";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";

@Injectable()
export class UploadService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // Uploads an image to the public 'post-media' bucket using the service role
  // (bypasses storage RLS — no user session needed).
  async upload(file: any) {
    if (!file) {
      throw new BadRequestException("No file provided.");
    }

    const supabase = this.supabaseService.createServiceClient();

    const originalName = file.originalname || "file";
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "-");
    const path = `${OWNER_ID}/${Date.now()}-${safeName}`;

    const buffer: Buffer = file.buffer;
    const hash = createHash("sha256").update(buffer).digest("hex");

    const { error: uploadError } = await supabase.storage
      .from("post-media")
      .upload(path, buffer, { contentType: file.mimetype || "image/jpeg", upsert: true });

    if (uploadError) {
      console.error("[Upload] error:", uploadError.message);
      throw new InternalServerErrorException(uploadError.message);
    }

    const { data } = supabase.storage.from("post-media").getPublicUrl(path);
    return {
      url: data.publicUrl,
      storagePath: path,
      filename: safeName,
      mimeType: file.mimetype || "image/jpeg",
      sizeBytes: buffer.byteLength,
      hash,
    };
  }
}
