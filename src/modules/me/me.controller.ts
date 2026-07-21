import { Controller, Get } from "@nestjs/common";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("me")
export class MeController {
  // GET /api/me — the logged-in user's profile (attached by the auth guard).
  @Get()
  me(@CurrentProfile() profile: any) {
    return { profile: profile || null };
  }
}
