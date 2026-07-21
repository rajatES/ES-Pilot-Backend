import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth/public.decorator";

@Controller()
export class HealthController {
  @Public()
  @Get("health")
  health() {
    return { ok: true, service: "essentially-posting-pilot-backend", time: new Date().toISOString() };
  }
}
