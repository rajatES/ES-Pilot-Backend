import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";

const KEY = "app";

@Injectable()
export class SettingsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async get() {
    const supabase = this.supabaseService.createServiceClient();
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("user_id", OWNER_ID)
      .eq("key", KEY)
      .maybeSingle();
    return { settings: data?.value || {} };
  }

  async update(value: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { error } = await supabase
      .from("app_settings")
      .upsert(
        { user_id: OWNER_ID, key: KEY, value, updated_at: new Date().toISOString() },
        { onConflict: "user_id,key" },
      );
    if (error) throw new InternalServerErrorException(error.message);
    return { ok: true, settings: value };
  }
}
