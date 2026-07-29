import { Controller, Get, Post, Req } from "@nestjs/common";
import { Request } from "express";
import { CronService } from "./cron.service";
import { Public } from "../../auth/public.decorator";

// All cron routes authenticate with CRON_SECRET (handled in the service), not a
// user session, so they bypass the global auth guard. GET and POST behave
// identically (a scheduler can hit either).
@Public()
@Controller("cron")
export class CronController {
  constructor(private readonly cron: CronService) {}

  @Get("publish")
  publishGet(@Req() req: Request) {
    return this.cron.publish(req);
  }
  @Post("publish")
  publishPost(@Req() req: Request) {
    return this.cron.publish(req);
  }

  @Get("verify-posts")
  verifyGet(@Req() req: Request) {
    return this.cron.verifyPosts(req);
  }
  @Post("verify-posts")
  verifyPost(@Req() req: Request) {
    return this.cron.verifyPosts(req);
  }

  @Get("insights")
  insightsGet(@Req() req: Request) {
    return this.cron.insights(req);
  }
  @Post("insights")
  insightsPost(@Req() req: Request) {
    return this.cron.insights(req);
  }

  @Get("auto-approve")
  autoApproveGet(@Req() req: Request) {
    return this.cron.autoApprove(req);
  }
  @Post("auto-approve")
  autoApprovePost(@Req() req: Request) {
    return this.cron.autoApprove(req);
  }

  @Get("sync-posts")
  syncPostsGet(@Req() req: Request) {
    return this.cron.syncPosts(req);
  }
  @Post("sync-posts")
  syncPostsPost(@Req() req: Request) {
    return this.cron.syncPosts(req);
  }
}
