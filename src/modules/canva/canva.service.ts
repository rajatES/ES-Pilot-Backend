import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { StorageService } from "../../storage/storage.service";
import { CANVA_API, canvaConfigured, getCanvaAccessToken } from "../../lib/canva";

@Injectable()
export class CanvaService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly storage: StorageService,
  ) {}

  // Lists the logged-in teammate's own Canva designs.
  async designs(profile: any) {
    if (!canvaConfigured()) {
      throw new HttpException("Canva isn't configured.", HttpStatus.NOT_IMPLEMENTED);
    }
    if (!profile) throw new UnauthorizedException("Not logged in.");

    const token = await getCanvaAccessToken(profile.id);
    if (!token) return { connected: false, designs: [] };

    const res = await fetch(`${CANVA_API}/designs?limit=30`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      // Token revoked or scope changed — treat as disconnected.
      return { connected: false, designs: [] };
    }

    const designs = (data.items || []).map((d: any) => ({
      id: d.id,
      title: d.title || "Untitled design",
      thumbnail: d.thumbnail?.url || null,
      updatedAt: d.updated_at || null,
    }));
    return { connected: true, designs };
  }

  // Exports a Canva design as PNG and persists it to our media bucket.
  async export(profile: any, payload: any) {
    if (!canvaConfigured()) {
      throw new HttpException("Canva isn't configured.", HttpStatus.NOT_IMPLEMENTED);
    }
    if (!profile) throw new UnauthorizedException("Not logged in.");

    const token = await getCanvaAccessToken(profile.id);
    if (!token) {
      throw new HttpException("Canva isn't connected — connect it first.", HttpStatus.PRECONDITION_REQUIRED);
    }

    const { designId } = payload || {};
    if (!designId) throw new BadRequestException("designId is required.");

    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    let res = await fetch(`${CANVA_API}/exports`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ design_id: designId, format: { type: "png" } }),
    });
    let data = await res.json();
    if (!res.ok) {
      throw new HttpException(data?.message || "Canva export failed to start.", HttpStatus.BAD_GATEWAY);
    }

    // Poll the export job (Canva renders asynchronously).
    let job = data.job;
    const deadline = Date.now() + 60_000;
    while (job?.status === "in_progress" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetch(`${CANVA_API}/exports/${job.id}`, { headers: { Authorization: `Bearer ${token}` } });
      data = await res.json();
      if (!res.ok) break;
      job = data.job;
    }
    if (job?.status !== "success" || !job.urls?.length) {
      throw new HttpException("Canva export didn't finish — try again.", HttpStatus.BAD_GATEWAY);
    }

    // Persist to our storage: Canva export URLs expire quickly.
    const fileRes = await fetch(job.urls[0]);
    if (!fileRes.ok) throw new HttpException("Couldn't download the exported design.", HttpStatus.BAD_GATEWAY);
    const buf = Buffer.from(await fileRes.arrayBuffer());

    const key = `${OWNER_ID}/canva-${designId}-${Date.now()}.png`;
    const { url } = await this.storage.put(key, buf, "image/png");
    return { url };
  }
}
