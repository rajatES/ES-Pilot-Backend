import { Body, Controller, Post } from "@nestjs/common";
import { SocialService } from "./social.service";

@Controller("social/facebook")
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Post("fetch-pages")
  fetchPages(@Body() body: any) {
    return this.social.fetchPages(body);
  }

  @Post("confirm-pages")
  confirmPages(@Body() body: any) {
    return this.social.confirmPages(body);
  }
}
