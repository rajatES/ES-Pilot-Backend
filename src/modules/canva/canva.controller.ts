import { Body, Controller, Get, Post } from "@nestjs/common";
import { CanvaService } from "./canva.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("canva")
export class CanvaController {
  constructor(private readonly canva: CanvaService) {}

  @Get("designs")
  designs(@CurrentProfile() profile: any) {
    return this.canva.designs(profile);
  }

  @Post("export")
  export(@CurrentProfile() profile: any, @Body() body: any) {
    return this.canva.export(profile, body);
  }
}
