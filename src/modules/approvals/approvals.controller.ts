import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApprovalsService } from "./approvals.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("approvals")
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@Query("postId") postId?: string) {
    return this.approvals.list(postId);
  }

  // Page-grouped pending-approval queue (one item per post × page).
  @Get("pending")
  pending(@CurrentProfile() me: any) {
    return this.approvals.pending(me);
  }

  @Post()
  act(@CurrentProfile() me: any, @Body() body: any) {
    return this.approvals.act(me, body);
  }
}
