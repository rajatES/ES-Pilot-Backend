import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ApiKeysService } from "../api-keys/api-keys.service";

// Authenticates external /api/v1/* requests with a Developer API key
// (Authorization: Bearer pp_live_… or X-API-Key: pp_live_…). The v1 routes
// are @Public() so the global JwtAuthGuard skips them; this guard is the
// actual gate. On success the key's creating profile is attached the same
// way JwtAuthGuard does, so @CurrentProfile() and created_by keep working.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string = request.headers["authorization"] || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const presented = bearer || (request.headers["x-api-key"] || "").trim();

    if (!presented) {
      throw new UnauthorizedException(
        "Missing API key. Send it as 'Authorization: Bearer pp_live_…' or 'X-API-Key: pp_live_…'.",
      );
    }

    const resolved = await this.apiKeys.validate(presented);
    if (!resolved) throw new UnauthorizedException("Invalid or revoked API key.");

    request.user = resolved.profile;
    request.profile = resolved.profile;
    request.apiKey = resolved.key;
    return true;
  }
}
