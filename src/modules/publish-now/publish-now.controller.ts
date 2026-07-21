import { Body, Controller, Post } from "@nestjs/common";
import { PublishNowService } from "./publish-now.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("publish-now")
export class PublishNowController {
  constructor(private readonly publishNow: PublishNowService) {}

  @Post()
  publish(@Body() body: any, @CurrentProfile() profile: any) {
    return this.publishNow.publish(body, profile);
  }
}
