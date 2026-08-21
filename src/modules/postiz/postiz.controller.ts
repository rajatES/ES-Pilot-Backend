import { Body, Controller, Get, Post } from "@nestjs/common";
import { PostizService } from "./postiz.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

// Postiz channel import — Threads and personal/standalone Instagram. JWT-
// protected like every other route; admin/Group-Head enforced in the service.
// There is no OAuth start/callback pair here: Postiz runs that flow in its own
// UI, and these routes only read the result and copy it into social_accounts.
@Controller("postiz")
export class PostizController {
  constructor(private readonly postiz: PostizService) {}

  // GET /api/postiz/status — { configured, connected, error }
  @Get("status")
  status(@CurrentProfile() me: any) {
    return this.postiz.status(me);
  }

  // GET /api/postiz/integrations — importable channels + an `imported` flag.
  @Get("integrations")
  integrations(@CurrentProfile() me: any) {
    return this.postiz.integrations(me);
  }

  // POST /api/postiz/import — body { channels: [{ id, category? }] }
  @Post("import")
  importChannels(@Body() body: any, @CurrentProfile() me: any) {
    return this.postiz.importChannels(body, me);
  }
}
