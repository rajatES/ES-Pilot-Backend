import { Injectable } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";

@Injectable()
export class SearchService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // Universal search across posts, accounts, and templates.
  async search(query: string) {
    const q = (query || "").trim();
    if (!q) return { results: [] };

    const supabase = this.supabaseService.createServiceClient();
    const like = `%${q}%`;
    const [posts, accounts, templates] = await Promise.all([
      supabase
        .from("scheduled_posts")
        .select("id,body,status,scheduled_for")
        .eq("user_id", OWNER_ID)
        .ilike("body", like)
        .limit(10),
      supabase
        .from("social_accounts")
        .select("id,display_name,platform,category")
        .eq("user_id", OWNER_ID)
        .ilike("display_name", like)
        .limit(10),
      supabase
        .from("templates")
        .select("id,name,kind,content")
        .eq("user_id", OWNER_ID)
        .ilike("name", like)
        .limit(10),
    ]);

    const results = [
      ...(posts.data || []).map((p) => ({
        type: "post",
        id: p.id,
        title: p.body?.slice(0, 80) || "(no caption)",
        sub: p.status,
      })),
      ...(accounts.data || []).map((a) => ({
        type: "account",
        id: a.id,
        title: a.display_name,
        sub: `${a.platform} · ${a.category || "Other"}`,
      })),
      ...(templates.data || []).map((t) => ({ type: "template", id: t.id, title: t.name, sub: t.kind })),
    ];

    return { results };
  }
}
