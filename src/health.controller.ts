import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth/public.decorator";

@Controller()
export class HealthController {
  @Public()
  @Get("health")
  health() {
    return { ok: true, service: "es-social-post-backend", time: new Date().toISOString() };
  }
}
