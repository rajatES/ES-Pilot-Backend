import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
// @ts-ignore - plain JS seed library.
import { DEFAULT_DESIGN_TEMPLATES } from "../../lib/designTemplateLibrary";
// @ts-ignore - plain JS vision-derive helper (env-gated, never throws).
import { deriveTemplatePrompt, deriveEnabled } from "../../lib/templateVision";

@Injectable()
export class DesignTemplatesService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // GET /api/design-templates — the library, seeded on first read.
  async list() {
    const supabase = this.supabaseService.createServiceClient();
    const read = () =>
      supabase
        .from("design_templates")
        .select("*")
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true });

    let { data, error } = await read();
    if (error) throw new InternalServerErrorException(error.message);

    if (!data || data.length === 0) {
      const rows = DEFAULT_DESIGN_TEMPLATES.map((t: any) => ({
        name: t.name,
        description: t.description || null,
        prompt: t.prompt,
        tags: t.tags || [],
        story_types: t.story_types || [],
        template_key: t.key,
        is_default: true,
      }));
      const { error: seedError } = await supabase.from("design_templates").insert(rows);
      if (seedError) {
        /* a concurrent request may have seeded first — fall through to re-read */
      }
      const reread = await read();
      data = reread.data || [];
    }
    return { templates: data, deriveEnabled: deriveEnabled() };
  }

  async create(me: any, body: any) {
    const name = String(body?.name || "").trim();
    const prompt = String(body?.prompt || "").trim();
    if (!name) throw new BadRequestException("A template name is required.");
    if (!prompt) throw new BadRequestException("A prompt is required.");

    const supabase = this.supabaseService.createServiceClient();
    const { data, error } = await supabase
      .from("design_templates")
      .insert({
        name,
        prompt,
        description: body?.description ? String(body.description) : null,
        tags: Array.isArray(body?.tags) ? body.tags : [],
        story_types: Array.isArray(body?.storyTypes) ? body.storyTypes : [],
        is_default: false,
        created_by: me?.id || null,
      })
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return { template: data };
  }

  async update(id: string, body: any) {
    const supabase = this.supabaseService.createServiceClient();
    const update: any = {};
    if (body?.name !== undefined) {
      const n = String(body.name || "").trim();
      if (!n) throw new BadRequestException("A template name is required.");
      update.name = n;
    }
    if (body?.prompt !== undefined) {
      const p = String(body.prompt || "").trim();
      if (!p) throw new BadRequestException("A prompt is required.");
      update.prompt = p;
    }
    if (body?.description !== undefined) update.description = body.description ? String(body.description) : null;
    if (Array.isArray(body?.tags)) update.tags = body.tags;
    if (Array.isArray(body?.storyTypes)) update.story_types = body.storyTypes;
    if (!Object.keys(update).length) throw new BadRequestException("Nothing to update.");

    const { data, error } = await supabase.from("design_templates").update(update).eq("id", id).select().single();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException("Template not found.");
    return { template: data };
  }

  async remove(id: string) {
    const supabase = this.supabaseService.createServiceClient();
    const { error } = await supabase.from("design_templates").delete().eq("id", id);
    if (error) throw new InternalServerErrorException(error.message);
    return { ok: true };
  }

  // POST /api/design-templates/derive { imageDataUrl } → { prompt }
  async derive(body: any) {
    const r = await deriveTemplatePrompt(body?.imageDataUrl || "");
    if (!r.ok) throw new BadRequestException(r.error || "Couldn't derive a prompt from that image.");
    return { prompt: r.prompt };
  }
}
