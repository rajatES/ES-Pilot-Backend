import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService } from "../../supabase/supabase.service";
import { AuthCoreService } from "../../auth/auth-core.service";

@Injectable()
export class SignupService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly auth: AuthCoreService,
  ) {}

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

    // Self-signup creates the seat immediately but "pending" until an admin
    // approves it. Password is bcrypt-hashed by AuthCoreService.
    const profile = await this.auth.createUser({
      email: email.trim(),
      password,
      displayName: displayName.trim(),
      role: "member",
      divisionId: division.id,
      isGroupHead,
      status: "pending",
    });

    return { profile };
  }
}
