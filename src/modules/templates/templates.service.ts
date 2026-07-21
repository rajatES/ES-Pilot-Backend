import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";

@Injectable()
export class TemplatesService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async list(kind?: string) {
    const supabase = this.supabaseService.createServiceClient();
    let q = supabase
      .from("templates")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("updated_at", { ascending: false });
    if (kind) q = q.eq("kind", kind);
    const { data, error } = await q;
    if (error) throw new InternalServerErrorException(error.message);
    return { templates: data };
  }

  async create(payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { kind, name, content, data } = payload || {};
    if (!kind || !name) throw new BadRequestException("kind and name are required.");
    const { data: row, error } = await supabase
      .from("templates")
      .insert({ user_id: OWNER_ID, kind, name, content: content || null, data: data || {} })
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return { template: row };
  }

  async update(id: string, payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { name, content, data } = payload || {};
    const update: any = { updated_at: new Date().toISOString() };
    if (name !== undefined) update.name = name;
    if (content !== undefined) update.content = content;
    if (data !== undefined) update.data = data;
    const { data: row, error } = await supabase
      .from("templates")
      .update(update)
      .eq("id", id)
      .eq("user_id", OWNER_ID)
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return { template: row };
  }

  async remove(id: string) {
    const supabase = this.supabaseService.createServiceClient();
    const { error } = await supabase.from("templates").delete().eq("id", id).eq("user_id", OWNER_ID);
    if (error) throw new InternalServerErrorException(error.message);
    return { ok: true };
  }
}
