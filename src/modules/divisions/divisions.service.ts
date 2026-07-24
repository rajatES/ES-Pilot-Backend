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

@Injectable()
export class DivisionsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private requireAdmin(me: any) {
    if (!me) throw new UnauthorizedException("Not logged in.");
    if (me.role !== "admin") throw new ForbiddenException("Only admins can manage divisions.");
  }

  // A positive integer, or null when left blank.
  private parseTarget(v: any): number | null {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new BadRequestException("Daily target must be a positive number.");
    return Math.floor(n);
  }

  // Any signed-in user can read the list (it powers the assignment dropdowns);
  // each row carries how many teammates are assigned to it.
  async list(me: any) {
    if (!me) throw new UnauthorizedException("Not logged in.");
    const supabase = this.supabaseService.createServiceClient();
    const [{ data: divisions, error }, { data: profiles }] = await Promise.all([
      supabase.from("divisions").select("*").order("name", { ascending: true }),
      supabase.from("profiles").select("id, division_id"),
    ]);
    if (error) throw new InternalServerErrorException(error.message);

    const counts: Record<string, number> = {};
    for (const p of profiles || []) {
      if (p.division_id) counts[p.division_id] = (counts[p.division_id] || 0) + 1;
    }
    return { divisions: (divisions || []).map((d: any) => ({ ...d, member_count: counts[d.id] || 0 })) };
  }

  async create(me: any, payload: any) {
    this.requireAdmin(me);
    const name = String(payload?.name || "").trim();
    if (!name) throw new BadRequestException("A division name is required.");

    const supabase = this.supabaseService.createServiceClient();
    const { data: existing } = await supabase.from("divisions").select("id").ilike("name", name);
    if ((existing || []).length) throw new ConflictException("A division with that name already exists.");

    const { data, error } = await supabase
      .from("divisions")
      .insert({
        name,
        group_head: payload?.groupHead ? String(payload.groupHead).trim() : null,
        daily_target: this.parseTarget(payload?.dailyTarget),
      })
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);

    await logActivity({ type: "division.created", title: `Created division "${name}"`, status: "info" });
    return { division: data };
  }

  async update(me: any, id: string, payload: any) {
    this.requireAdmin(me);
    const supabase = this.supabaseService.createServiceClient();

    const update: any = {};
    if (payload?.name !== undefined) {
      const name = String(payload.name || "").trim();
      if (!name) throw new BadRequestException("A division name is required.");
      const { data: existing } = await supabase.from("divisions").select("id").ilike("name", name);
      if ((existing || []).some((d: any) => d.id !== id)) {
        throw new ConflictException("A division with that name already exists.");
      }
      update.name = name;
    }
    if (payload?.groupHead !== undefined) {
      update.group_head = payload.groupHead ? String(payload.groupHead).trim() : null;
    }
    if (payload?.dailyTarget !== undefined) {
      update.daily_target = this.parseTarget(payload.dailyTarget);
    }
    if (!Object.keys(update).length) throw new BadRequestException("Nothing to update.");

    const { data, error } = await supabase.from("divisions").update(update).eq("id", id).select().single();
    if (error) throw new InternalServerErrorException(error.message);
    return { division: data };
  }

  async remove(me: any, id: string) {
    this.requireAdmin(me);
    const supabase = this.supabaseService.createServiceClient();

    const { data: division } = await supabase.from("divisions").select("*").eq("id", id).maybeSingle();
    if (!division) throw new NotFoundException("Division not found.");

    // Unassign members first so no profile is left pointing at a division that
    // no longer exists.
    const { data: members } = await supabase.from("profiles").select("id").eq("division_id", id);
    const unassigned = (members || []).length;
    if (unassigned) {
      await supabase.from("profiles").update({ division_id: null }).eq("division_id", id);
    }

    const { error } = await supabase.from("divisions").delete().eq("id", id);
    if (error) throw new InternalServerErrorException(error.message);

    await logActivity({
      type: "division.deleted",
      title: `Deleted division "${division.name}"`,
      status: "info",
      meta: { unassigned },
    });
    return { ok: true, unassigned };
  }
}
