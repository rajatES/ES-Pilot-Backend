import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { SportsService } from "./sports.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("sports")
export class SportsController {
  constructor(private readonly sports: SportsService) {}

  @Get()
  list() {
    return this.sports.list();
  }

  @Post()
  @HttpCode(201)
  create(@CurrentProfile() me: any, @Body() body: any) {
    return this.sports.create(me, body);
  }

  @Delete(":id")
  remove(@CurrentProfile() me: any, @Param("id") id: string) {
    return this.sports.remove(me, id);
  }
}
