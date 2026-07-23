import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { SupabaseService } from "../../supabase/supabase.service";
import { logActivity } from "../../lib/activity";

// Developer API keys for external integrations (automations, n8n, Zapier…).
// The full key ("pp_live_<64 hex>") is returned exactly once at creation and
// stored only as a sha256 hash — lookups hash the presented key and match on
// key_hash, so a DB leak never exposes usable keys.
const KEY_PREFIX = "pp_live_";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

@Injectable()
export class ApiKeysService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private assertAdmin(me: any) {
    if (me?.role !== "admin") {
      throw new ForbiddenException("Only admins can manage API keys.");
    }
  }

  // GET /api/api-keys — list (never exposes hashes; prefix only).
  async list(me: any) {
    this.assertAdmin(me);
    const db = this.supabaseService.createServiceClient();
    const { data, error } = await db
      .from("api_keys")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new BadRequestException(error.message);
    // Map fields explicitly — the pg shim ignores column projections
    // (always `select *`), and key_hash must never leave the server.
    return {
      keys: (data || []).map((k: any) => ({
        id: k.id,
        name: k.name,
        key_prefix: k.key_prefix,
        created_by: k.created_by,
        last_used_at: k.last_used_at,
        revoked_at: k.revoked_at,
        created_at: k.created_at,
      })),
    };
  }

  // POST /api/api-keys — mint a key. The `key` field in the response is the
  // only time the full secret ever leaves the server.
  async create(payload: any, me: any) {
    this.assertAdmin(me);
    const name = (payload?.name || "").trim();
    if (!name) throw new BadRequestException("Key name is required.");
    if (name.length > 80) throw new BadRequestException("Key name is too long (max 80 chars).");

    const key = KEY_PREFIX + randomBytes(32).toString("hex");
    const db = this.supabaseService.createServiceClient();
    const { data, error } = await db
      .from("api_keys")
      .insert({
        name,
        key_hash: hashApiKey(key),
        key_prefix: key.slice(0, KEY_PREFIX.length + 6) + "…",
        created_by: me?.id || null,
      })
      .select("id, name, key_prefix, created_at")
      .single();
    if (error) throw new BadRequestException(error.message);

    await logActivity({
      type: "api_key.created",
      title: `Created API key "${name}"`,
      status: "info",
      meta: { keyId: data.id },
    });
    // Pick fields explicitly — the pg shim returns ALL columns from
    // insert…returning, and key_hash must never leave the server.
    return { id: data.id, name: data.name, key_prefix: data.key_prefix, created_at: data.created_at, key };
  }

  // DELETE /api/api-keys/:id — revoke (kept as a row for the audit trail).
  async revoke(id: string, me: any) {
    this.assertAdmin(me);
    const db = this.supabaseService.createServiceClient();
    const { data: existing } = await db.from("api_keys").select("id, name, revoked_at").eq("id", id).maybeSingle();
    if (!existing) throw new NotFoundException("API key not found.");
    if (existing.revoked_at) return { ok: true };

    const { error } = await db.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (error) throw new BadRequestException(error.message);

    await logActivity({
      type: "api_key.revoked",
      title: `Revoked API key "${existing.name}"`,
      status: "warning",
      meta: { keyId: id },
    });
    return { ok: true };
  }

  // Used by ApiKeyGuard: resolve a presented key to its row + owning profile.
  // Returns null unless the key exists and is not revoked.
  async validate(presentedKey: string) {
    if (!presentedKey?.startsWith(KEY_PREFIX)) return null;
    const db = this.supabaseService.createServiceClient();
    const { data: row } = await db
      .from("api_keys")
      .select("*")
      .eq("key_hash", hashApiKey(presentedKey))
      .maybeSingle();
    if (!row || row.revoked_at) return null;

    // Best-effort usage timestamp — never block the request on it.
    db.from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", row.id)
      .then(
        () => {},
        () => {},
      );

    let profile = null;
    if (row.created_by) {
      const { data } = await db.from("profiles").select("*").eq("id", row.created_by).maybeSingle();
      profile = data || null;
      if (profile) delete profile.password_hash;
    }
    return { key: row, profile };
  }
}
