import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { InsightsService } from "./insights.service";
import { SocialSyncService } from "./social-sync.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("insights")
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly socialSync: SocialSyncService,
  ) {}

  // ?days=N, or ?start=YYYY-MM-DD&end=YYYY-MM-DD for a custom range.
  @Get()
  list(@Query() query: any) {
    return this.insights.list(query || {});
  }

  // Detailed per-post×page rows for the Post Analytics table.
  @Get("posts")
  postsDetailed(@Query() query: any) {
    return this.insights.postsDetailed(query || {});
  }

  @Post("refresh")
  refresh(@Body() body: any) {
    return this.insights.refresh(body || {});
  }

  // Pull ALL posts (organic + app-made) from connected FB/IG accounts into
  // social_posts. Admin-only (enforced in the service). Heavier op — hits the
  // platform APIs per post; the body carries the window (days/start/end).
  @Post("sync")
  sync(@Body() body: any, @CurrentProfile() me: any) {
    return this.socialSync.sync(me, body || {});
  }
}
