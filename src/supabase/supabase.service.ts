import { Injectable } from "@nestjs/common";
// @ts-ignore - plain JS data layer (Postgres-backed supabase-compatible client).
import { createServiceSupabase, OWNER_ID } from "../lib/supabaseServer";

export { OWNER_ID };

// Data-access facade. The name is kept because ~25 services inject it; it now
// hands out the Postgres-backed query client (lib/supabaseServer.js) rather
// than a real Supabase client. Auth moved to AuthCoreService.
@Injectable()
export class SupabaseService {
  // Query client for all server-side data access.
  createServiceClient(): any {
    return createServiceSupabase();
  }
}
