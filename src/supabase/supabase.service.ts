import { Injectable } from "@nestjs/common";
// @ts-ignore - plain JS data layer (Postgres-backed supabase-compatible client).
import { createServiceSupabase, OWNER_ID } from "../lib/supabaseServer";

export { OWNER_ID };

// Data-access facade over the Postgres query client (lib/supabaseServer.js).
// The historical name is kept because every service injects it.
@Injectable()
export class SupabaseService {
  // Query client for all server-side data access.
  createServiceClient(): any {
    return createServiceSupabase();
  }
}
