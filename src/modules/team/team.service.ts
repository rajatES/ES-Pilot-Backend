import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { AuthCoreService } from "../../auth/auth-core.service";

// The hardcoded seed roster for POST /api/team/bulk, ported verbatim from the
// original one-time seeding route.
const SEED_MEMBERS = [
  { email: "phadke531@gmail.com", displayName: "Atharv Phadke", password: "Atharv47NBA", role: "GH" },
  { email: "akib.mukhi@gmail.com", displayName: "Akib Mukhi", password: "Akib83NBA", role: "member" },
  { email: "maazkureshi.arms@gmail.com", displayName: "Maaz Kureshi", password: "Maaz61NBA", role: "member" },
  { email: "nicolerosemarina@gmail.com", displayName: "Nicole Pereria", password: "Nicole29NBA", role: "member" },
  { email: "amritbiswas10@gmail.com", displayName: "Amrit Biswas", password: "Amrit54NBA", role: "member" },
  { email: "harshikasaha@gmail.com", displayName: "Harshika Saha", password: "Harshika72NBA", role: "member" },
  { email: "dear261990@gmail.com", displayName: "Miguel Sara", password: "Miguel38NBA", role: "member" },
  { email: "prajjwalbinwar@gmail.com", displayName: "Prajjwal Singh Binwar", password: "Prajjwal91NBA", role: "member" },
  { email: "brahmidhaytadak99@gmail.com", displayName: "Brahmi Dhaytadak", password: "Brahmi45NASCAR", role: "GH" },
  { email: "gauravwork67@gmail.com", displayName: "Gaurav Rikhari", password: "Gaurav17NASCAR", role: "member" },
  { email: "kabirh756@gmail.com", displayName: "Humayun Kabir", password: "Humayun63NASCAR", role: "member" },
  { email: "themick3y@gmail.com", displayName: "Ayush Chadak", password: "Ayush82NASCAR", role: "member" },
  { email: "gauravbhalerao109@gmail.com", displayName: "Gaurav Bhalerao", password: "Gaurav36NASCAR", role: "member" },
  { email: "richinx10@gmail.com", displayName: "Richin Mulla", password: "Richin74NASCAR", role: "member" },
  { email: "aniruddha.divakar992@gmail.com", displayName: "Anirudha", password: "Anirudha58NASCAR", role: "member" },
  { email: "mitraswastika3@gmail.com", displayName: "Swastika Mitra", password: "Swastika23NASCAR", role: "member" },
  { email: "k7200184@gmail.com", displayName: "Krishna Moorthy", password: "Krishna49NASCAR", role: "member" },
  { email: "khanafreelancer@gmail.com", displayName: "Saiful Huda Khan", password: "Saiful67NASCAR", role: "member" },
  { email: "mukharghosh@gmail.com", displayName: "Mukhar", password: "Mukhar31NFL", role: "GH" },
  { email: "clinton7m@gmail.com", displayName: "Clinton", password: "Clinton85NFL", role: "member" },
  { email: "sanketbhunia@gmail.com", displayName: "Sanket Bhunia", password: "Sanket42NFL", role: "member" },
  { email: "singh.harshrocksharsh@gmail.com", displayName: "Harsh Vardhan Singh", password: "Harsh76NFL", role: "member" },
  { email: "ak814326@gmail.com", displayName: "Arman Khan", password: "Arman53UFC", role: "GH" },
  { email: "amondal9226@gmail.com", displayName: "Anik", password: "Anik19UFC", role: "member" },
  { email: "ruhaanabdul27@gmail.com", displayName: "Abdul Ruhaan", password: "Abdul37UFC", role: "member" },
  { email: "skrdream478@gmail.com", displayName: "Arman Ali", password: "Arman68UFC", role: "member" },
  { email: "hamzashabbir937@gmail.com", displayName: "Hamza", password: "Hamza92UFC", role: "member" },
  { email: "dev567khurana@gmail.com", displayName: "Dev Khurana", password: "Dev25UFC", role: "member" },
  { email: "sahilsood61@gmail.com", displayName: "Sahil", password: "Sahil44UFC", role: "member" },
  { email: "dnyanuj1607@gmail.com", displayName: "Dnyaneshwari", password: "Dnyaneshwari56Golf", role: "member" },
  { email: "dinasourera@gmail.com", displayName: "Soumya", password: "Soumya78Tennis", role: "GH" },
  { email: "ronaktrivedi1997@gmail.com", displayName: "Raunak", password: "Raunak13Tennis", role: "member" },
  { email: "anjalidwivedi234@gmail.com", displayName: "Anjali", password: "Anjali69Tennis", role: "member" },
  { email: "shivam01.pgdm13nc@globsyn.edu.in", displayName: "Shivam", password: "Shivam34Tennis", role: "member" },
  { email: "guransh.sodhi@essentiallysports.com", displayName: "Guransh", password: "Guransh87CollegeFootball", role: "GH" },
  { email: "virjianianuj07@gmail.com", displayName: "Anuj Virjiani", password: "Anuj52USS", role: "member" },
  { email: "aditya1singh6@gmail.com", displayName: "Aditya", password: "Aditya96WWE", role: "member" },
];

@Injectable()
export class TeamService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly auth: AuthCoreService,
  ) {}

  async list(me: any) {
    if (!me) throw new UnauthorizedException("Not logged in.");
    const supabase = this.supabaseService.createServiceClient();
    const [{ data, error }, { data: divisions }] = await Promise.all([
      supabase.from("profiles").select("*").order("created_at", { ascending: true }),
      supabase.from("divisions").select("*").order("name", { ascending: true }),
    ]);
    if (error) throw new InternalServerErrorException(error.message);
    for (const p of data || []) delete p.password_hash; // never expose hashes
    return { team: data, me, divisions: divisions || [] };
  }

  // Admin-only: create a new seat with a temp password.
  async create(me: any, payload: any) {
    if (!me) throw new UnauthorizedException("Not logged in.");
    if (me.role !== "admin") throw new ForbiddenException("Only admins can add teammates.");

    const { email, password, displayName, role, divisionId, isGroupHead } = payload || {};
    if (!email?.trim() || !password || password.length < 8 || !displayName?.trim()) {
      throw new BadRequestException("Email, a display name, and an 8+ character password are required.");
    }

    const profile = await this.auth.createUser({
      email: email.trim(),
      password,
      displayName: displayName.trim(),
      role: role === "admin" ? "admin" : "member",
      divisionId: divisionId || null,
      isGroupHead: !!isGroupHead,
      status: "active",
    });

    return { profile };
  }

  // Admin-only: change role/division/status, or approve/reject a signup.
  async update(me: any, id: string, payload: any) {
    if (!me) throw new UnauthorizedException("Not logged in.");
    if (me.role !== "admin") throw new ForbiddenException("Only admins can change teammates.");

    const { role, divisionId, status, isGroupHead } = payload || {};
    const supabase = this.supabaseService.createServiceClient();

    if (status === "rejected") {
      if (id === me.id) throw new BadRequestException("You can't remove your own seat.");
      await supabase.from("profiles").delete().eq("id", id);
      return { ok: true };
    }

    const update: any = {};
    if (role !== undefined) {
      if (!["admin", "member"].includes(role)) throw new BadRequestException("Invalid role.");
      if (id === me.id && role !== "admin") throw new BadRequestException("You can't demote yourself.");
      update.role = role;
    }
    if (divisionId !== undefined) update.division_id = divisionId || null;
    if (isGroupHead !== undefined) update.is_group_head = !!isGroupHead;
    if (status !== undefined) {
      if (!["active", "pending"].includes(status)) throw new BadRequestException("Invalid status.");
      update.status = status;
    }
    if (!Object.keys(update).length) throw new BadRequestException("Nothing to update.");

    const { data: profile, error } = await supabase.from("profiles").update(update).eq("id", id).select().single();
    if (error) throw new InternalServerErrorException(error.message);
    return { profile };
  }

  // Admin-only: remove a seat entirely.
  async remove(me: any, id: string) {
    if (!me) throw new UnauthorizedException("Not logged in.");
    if (me.role !== "admin") throw new ForbiddenException("Only admins can remove teammates.");
    if (id === me.id) throw new BadRequestException("You can't remove your own seat.");

    const supabase = this.supabaseService.createServiceClient();
    await supabase.from("profiles").delete().eq("id", id);
    return { ok: true };
  }

  // Per-associate / per-division post counts.
  async stats(me: any, filters: { from?: string; to?: string; divisionId?: string }) {
    if (!me) throw new UnauthorizedException("Not logged in.");

    const { from, to } = filters;
    const divisionFilter = filters.divisionId || null;
    const supabase = this.supabaseService.createServiceClient();

    let query = supabase
      .from("scheduled_posts")
      .select("id, created_by, content_type, status, scheduled_for")
      .eq("user_id", OWNER_ID)
      .not("status", "in", "(draft,deleted)");
    if (from) query = query.gte("scheduled_for", new Date(from).toISOString());
    if (to) query = query.lte("scheduled_for", new Date(new Date(to).getTime() + 86400000 - 1).toISOString());

    const [{ data: posts, error: postsError }, { data: profiles, error: profilesError }, { data: divisions, error: divisionsError }] =
      await Promise.all([
        query,
        supabase.from("profiles").select("id, display_name, division_id"),
        supabase.from("divisions").select("id, name, daily_target").order("name", { ascending: true }),
      ]);
    if (postsError || profilesError || divisionsError) {
      throw new InternalServerErrorException(
        postsError?.message || profilesError?.message || divisionsError?.message,
      );
    }

    const profileById = new Map((profiles || []).map((p) => [p.id, p]));
    const divisionById = new Map((divisions || []).map((d) => [d.id, d]));

    const blankCounts = () => ({ total: 0, infographic: 0, meme_image: 0, lic: 0, untagged: 0 });
    const bump = (entry: any, contentType: any) => {
      entry.total += 1;
      if (contentType && entry[contentType] !== undefined) entry[contentType] += 1;
      else entry.untagged += 1;
    };

    const byAssociate = new Map();
    const byDivision = new Map();

    for (const post of posts || []) {
      const profile: any = post.created_by ? profileById.get(post.created_by) : null;
      const divId = profile?.division_id || null;
      if (divisionFilter && divId !== divisionFilter) continue;

      if (post.created_by) {
        if (!byAssociate.has(post.created_by)) {
          byAssociate.set(post.created_by, {
            profileId: post.created_by,
            displayName: profile?.display_name || "Unknown",
            divisionName: divId ? (divisionById.get(divId) as any)?.name || "—" : "—",
            ...blankCounts(),
          });
        }
        bump(byAssociate.get(post.created_by), post.content_type);
      }

      const divKey = divId || "unassigned";
      if (!byDivision.has(divKey)) {
        byDivision.set(divKey, {
          divisionId: divId,
          divisionName: divId ? (divisionById.get(divId) as any)?.name || "—" : "Unassigned",
          dailyTarget: divId ? (divisionById.get(divId) as any)?.daily_target || null : null,
          ...blankCounts(),
        });
      }
      bump(byDivision.get(divKey), post.content_type);
    }

    return {
      associates: Array.from(byAssociate.values()).sort((a: any, b: any) => b.total - a.total),
      divisions: Array.from(byDivision.values()).sort((a: any, b: any) => b.total - a.total),
      allDivisions: divisions || [],
    };
  }

  // Public: does any admin/profile already exist?
  async exists() {
    const supabase = this.supabaseService.createServiceClient();
    const { count, error } = await supabase.from("profiles").select("id", { count: "exact", head: true });
    if (error) throw new InternalServerErrorException(error.message);
    return { hasAdmin: (count || 0) > 0 };
  }

  // Public, one-time: create the first admin seat while profiles is empty.
  async bootstrap(payload: any) {
    const supabase = this.supabaseService.createServiceClient();

    const { count, error: countError } = await supabase.from("profiles").select("id", { count: "exact", head: true });
    if (countError) throw new InternalServerErrorException(countError.message);
    if ((count || 0) > 0) {
      throw new ConflictException("An admin account already exists. Ask them to invite you from Team settings.");
    }

    const { email, password, displayName } = payload || {};
    if (!email?.trim() || !password || password.length < 8 || !displayName?.trim()) {
      throw new BadRequestException("Email, a display name, and an 8+ character password are required.");
    }

    const profile = await this.auth.createUser({
      email: email.trim(),
      password,
      displayName: displayName.trim(),
      role: "admin",
      status: "active",
    });

    return { profile };
  }

  // Admin-only: seed the hardcoded roster.
  async bulk(me: any) {
    if (!me) throw new UnauthorizedException("Not logged in.");
    if (me.role !== "admin") throw new ForbiddenException("Admins only.");

    const results: any = { created: [], skipped: [], failed: [] };

    for (const m of SEED_MEMBERS) {
      try {
        if (await this.auth.emailExists(m.email)) {
          results.skipped.push(m.email);
          continue;
        }
        await this.auth.createUser({
          email: m.email,
          password: m.password,
          displayName: m.displayName,
          role: m.role === "GH" ? "GH" : "member",
          isGroupHead: m.role === "GH",
          status: "active",
        });
        results.created.push(m.email);
      } catch (err) {
        results.failed.push({ email: m.email, error: err.message });
      }
    }

    return results;
  }
}
