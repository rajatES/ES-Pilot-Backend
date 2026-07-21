import { Injectable } from "@nestjs/common";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
// @ts-ignore - plain JS helper ported verbatim from the original app.
import { createServiceSupabase, OWNER_ID } from "../lib/supabaseServer";

export { OWNER_ID };

@Injectable()
export class SupabaseService {
  private readonly url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  private readonly anonKey =
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  // Service-role client for all server-side data access. Delegates to the
  // canonical lib helper so controllers, services, and ported lib modules all
  // share one client configuration.
  createServiceClient(): SupabaseClient {
    return createServiceSupabase();
  }

  // Validates a Supabase access token (sent by the frontend as a Bearer header)
  // against Supabase's Auth server and returns the user, or null if invalid.
  async getUserFromToken(accessToken: string) {
    if (!accessToken) return null;
    const client = createClient(this.url, this.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser(accessToken);
    if (error) return null;
    return data.user || null;
  }

  // Looks up the app profile (display name / role / division) for a verified user id.
  async getProfile(userId: string) {
    if (!userId) return null;
    const service = this.createServiceClient();
    const { data } = await service.from("profiles").select("*").eq("id", userId).maybeSingle();
    return data || null;
  }
}
