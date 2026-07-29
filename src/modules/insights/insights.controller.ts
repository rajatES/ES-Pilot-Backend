import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { InsightsService } from "./insights.service";

@Controller("insights")
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  list(@Query("days") days?: string) {
    return this.insights.list(days ? Number(days) : 30);
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
}
