import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

// S3 media storage. Objects must be publicly readable: the social platforms
// fetch media by URL when publishing. Credentials come from env keys locally
// or the instance IAM role in production.
@Injectable()
export class StorageService {
  private client: S3Client | null = null;

  private get bucket(): string {
    const b = process.env.S3_BUCKET;
    if (!b) throw new InternalServerErrorException("S3_BUCKET is not configured.");
    return b;
  }

  private get region(): string {
    return process.env.AWS_REGION || "us-east-1";
  }

  private s3(): S3Client {
    if (!this.client) {
      // Credentials come from env vars or the instance's IAM role automatically.
      this.client = new S3Client({ region: this.region });
    }
    return this.client;
  }

  // Public URL for a stored object. Prefer an explicit CDN/base URL; otherwise
  // fall back to the virtual-hosted S3 URL.
  publicUrl(key: string): string {
    const base = process.env.S3_PUBLIC_URL;
    if (base) return `${base.replace(/\/$/, "")}/${key}`;
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  // Store a buffer and return its key + public URL.
  async put(key: string, body: Buffer | Uint8Array, contentType: string): Promise<{ key: string; url: string }> {
    try {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return { key, url: this.publicUrl(key) };
    } catch (e) {
      console.error("[storage] put failed:", e.message);
      throw new InternalServerErrorException("Media upload failed.");
    }
  }

  async remove(key: string): Promise<void> {
    if (!key) return;
    try {
      await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      console.warn("[storage] delete failed:", e.message);
    }
  }
}
