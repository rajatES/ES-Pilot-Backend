import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthCoreService } from "./auth-core.service";
import { IS_PUBLIC_KEY } from "./public.decorator";

// Verifies the JWT the frontend sends as `Authorization: Bearer <token>`, loads
// the profile row, and attaches it to the request. Replaces SupabaseAuthGuard.
//
// Routes decorated with @Public() (login, signup, cron, OAuth callbacks,
// team-exists/bootstrap) skip this and do their own authorization.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthCoreService,
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

    const payload = this.auth.verifyToken(token);
    if (!payload) throw new UnauthorizedException("Missing or invalid session token");

    const profile = await this.auth.findProfileById(payload.sub);
    if (!profile) throw new UnauthorizedException("Account no longer exists");
    delete profile.password_hash;

    // Both decorators (CurrentUser / CurrentProfile) resolve to the profile.
    request.user = profile;
    request.profile = profile;
    return true;
  }
}
