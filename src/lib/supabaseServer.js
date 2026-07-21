import { createClient } from "@supabase/supabase-js";

// Single-workspace mode: every row belongs to this fixed owner id.
// (Ported verbatim from the original Next.js lib/supabaseServer.js so all the
// other ported lib modules keep working with a one-line import change.)
export const OWNER_ID = "00000000-0000-0000-0000-000000000001";

// Service-role client bypasses RLS — used for all server-side data access.
// cache: "no-store" opts every query out of any fetch-level caching so GET
// handlers never serve a stale Supabase response.
export function createServiceSupabase() {
  return createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false },
      global: { fetch: (url, options) => fetch(url, { ...options, cache: "no-store" }) }
    }
  );
}
