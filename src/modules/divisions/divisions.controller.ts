import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { DivisionsService } from "./divisions.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("divisions")
export class DivisionsController {
  constructor(private readonly divisions: DivisionsService) {}

  @Get()
  list(@CurrentProfile() me: any) {
    return this.divisions.list(me);
  }

  @Post()
  @HttpCode(201)
  create(@CurrentProfile() me: any, @Body() body: any) {
    return this.divisions.create(me, body);
  }

  @Patch(":id")
  update(@CurrentProfile() me: any, @Param("id") id: string, @Body() body: any) {
    return this.divisions.update(me, id, body);
  }

  @Delete(":id")
  remove(@CurrentProfile() me: any, @Param("id") id: string) {
    return this.divisions.remove(me, id);
  }
}
