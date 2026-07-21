import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SupabaseService } from "../supabase/supabase.service";
import { IS_PUBLIC_KEY } from "./public.decorator";

// Replaces the old middleware.js + getCurrentProfile() pairing. The frontend now
// sends the Supabase session token as `Authorization: Bearer <token>`; this guard
// validates it against Supabase Auth and attaches { user, profile } to the request.
//
// Routes decorated with @Public() (cron, OAuth callbacks, signup, team-exists)
// skip this check and do their own authorization.
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header: string = request.headers["authorization"] || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    const user = await this.supabase.getUserFromToken(token);
    if (!user) {
      throw new UnauthorizedException("Missing or invalid session token");
    }

    request.user = user;
    request.profile = await this.supabase.getProfile(user.id);
    return true;
  }
}
