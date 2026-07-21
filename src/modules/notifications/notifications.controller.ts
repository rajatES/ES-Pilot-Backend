import { Body, Controller, Get, Patch } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list() {
    return this.notifications.list();
  }

  @Patch()
  markRead(@Body() body: any) {
    return this.notifications.markRead(body?.ids);
  }
}
