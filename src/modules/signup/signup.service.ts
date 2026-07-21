import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService } from "../../supabase/supabase.service";

@Injectable()
export class SignupService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // Public self-signup: creates the account immediately (own password) but the
  // profile stays "pending" until an admin approves. A "GH_" division-code
  // prefix requests Group Head status (still admin-approved).
  async signup(payload: any) {
    const supabase = this.supabaseService.createServiceClient();

    const { email, password, displayName, divisionCode } = payload || {};
    if (!email?.trim() || !password || password.length < 8 || !displayName?.trim() || !divisionCode?.trim()) {
      throw new BadRequestException(
        "Email, display name, an 8+ character password, and your division code are required.",
      );
    }

    const rawCode = divisionCode.trim();
    const isGroupHead = /^gh_/i.test(rawCode);
    const divisionName = isGroupHead ? rawCode.slice(3).trim() : rawCode;

    const { data: division, error: divisionError } = await supabase
      .from("divisions")
      .select("id, name")
      .ilike("name", divisionName)
      .maybeSingle();
    if (divisionError) throw new InternalServerErrorException(divisionError.message);
    if (!division) throw new BadRequestException("That division code wasn't recognized. Check with your Group Head.");

    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email: email.trim(),
      password,
      email_confirm: true,
    });
    if (createError) throw new BadRequestException(createError.message);

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .insert({
        id: created.user.id,
        email: email.trim(),
        display_name: displayName.trim(),
        role: "member",
        division_id: division.id,
        is_group_head: isGroupHead,
        status: "pending",
      })
      .select()
      .single();
    if (profileError) {
      await supabase.auth.admin.deleteUser(created.user.id).catch(() => {});
      throw new InternalServerErrorException(profileError.message);
    }

    return { profile };
  }
}
