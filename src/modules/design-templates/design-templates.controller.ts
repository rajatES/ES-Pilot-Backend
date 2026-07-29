import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { DesignTemplatesService } from "./design-templates.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("design-templates")
export class DesignTemplatesController {
  constructor(private readonly svc: DesignTemplatesService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  @HttpCode(201)
  create(@CurrentProfile() me: any, @Body() body: any) {
    return this.svc.create(me, body);
  }

  @Post("derive")
  derive(@Body() body: any) {
    return this.svc.derive(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: any) {
    return this.svc.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.svc.remove(id);
  }
}
