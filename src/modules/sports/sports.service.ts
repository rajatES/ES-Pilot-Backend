import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { logActivity } from "../../lib/activity";
// @ts-ignore - plain JS taxonomy list shared with the detector.
import { SPORTS } from "../../lib/sports";

// The historical fixed list, minus the reserved "Other" fallback. Seeded into
// the sports table the first time the list is read so nothing already in use
// disappears.
const DEFAULT_SPORTS: string[] = (SPORTS as string[]).filter((s) => s !== "Other");

@Injectable()
export class SportsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private requireAdmin(me: any) {
    if (!me) throw new UnauthorizedException("Not logged in.");
    if (me.role !== "admin") throw new ForbiddenException("Only admins can manage sports.");
  }

  // GET /api/sports — the editable taxonomy. Lazily seeds the defaults on first
  // access so existing account categories keep matching a list entry.
  async list() {
    const supabase = this.supabaseService.createServiceClient();
    const read = () =>
      supabase.from("sports").select("*").order("sort_order", { ascending: true }).order("name", { ascending: true });

    let { data, error } = await read();
    if (error) throw new InternalServerErrorException(error.message);

    if (!data || data.length === 0) {
      const rows = DEFAULT_SPORTS.map((name, i) => ({ name, sort_order: i }));
      const { error: seedError } = await supabase.from("sports").insert(rows);
      // A concurrent request may have seeded first (name is unique) — either
      // way, re-read to return the canonical list.
      if (seedError) { /* fall through to re-read */ }
      const reread = await read();
      data = reread.data || [];
    }
    return { sports: data };
  }

  async create(me: any, payload: any) {
    this.requireAdmin(me);
    const name = String(payload?.name || "").trim();
    if (!name) throw new BadRequestException("A sport name is required.");
    if (name.toLowerCase() === "other") throw new BadRequestException('"Other" is reserved and always available.');

    // Make sure the defaults are seeded before we compute the next sort_order.
    await this.list();

    const supabase = this.supabaseService.createServiceClient();
    const { data: existing } = await supabase.from("sports").select("*");
    if ((existing || []).some((s: any) => s.name.toLowerCase() === name.toLowerCase())) {
      throw new ConflictException("That sport already exists.");
    }
    const maxOrder = (existing || []).reduce((m: number, s: any) => Math.max(m, s.sort_order || 0), 0);

    const { data, error } = await supabase
      .from("sports")
      .insert({ name, sort_order: maxOrder + 1 })
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);

    await logActivity({ type: "sport.created", title: `Added sport "${name}"`, status: "info" });
    return { sport: data };
  }

  async remove(me: any, id: string) {
    this.requireAdmin(me);
    const supabase = this.supabaseService.createServiceClient();

    const { data: sport } = await supabase.from("sports").select("*").eq("id", id).maybeSingle();
    if (!sport) throw new NotFoundException("Sport not found.");

    // Move any pages set to this sport back to "Other" so no account is left
    // pointing at a category that no longer exists.
    const { data: affected } = await supabase
      .from("social_accounts")
      .select("id")
      .eq("user_id", OWNER_ID)
      .eq("category", sport.name);
    const reassigned = (affected || []).length;
    if (reassigned) {
      await supabase
        .from("social_accounts")
        .update({ category: "Other" })
        .eq("user_id", OWNER_ID)
        .eq("category", sport.name);
    }

    const { error } = await supabase.from("sports").delete().eq("id", id);
    if (error) throw new InternalServerErrorException(error.message);

    await logActivity({
      type: "sport.deleted",
      title: `Removed sport "${sport.name}"`,
      status: "info",
      meta: { reassigned },
    });
    return { ok: true, reassigned };
  }
}
