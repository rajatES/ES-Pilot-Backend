import { Body, Controller, Post } from "@nestjs/common";
import { ComplianceService } from "./compliance.service";

@Controller("compliance")
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Post("image")
  image(@Body() body: any) {
    return this.compliance.image(body);
  }

  @Post("live-check")
  liveCheck(@Body() body: any) {
    return this.compliance.liveCheck(body);
  }
}
