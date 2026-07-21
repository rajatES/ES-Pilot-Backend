import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { TemplatesService } from "./templates.service";

@Controller("templates")
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@Query("kind") kind?: string) {
    return this.templates.list(kind);
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: any) {
    return this.templates.create(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: any) {
    return this.templates.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.templates.remove(id);
  }
}
