import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { MediaService } from "./media.service";

@Controller("media")
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  list(
    @Query("folderId") folderId?: string,
    @Query("tag") tag?: string,
    @Query("favorite") favorite?: string,
    @Query("q") q?: string,
  ) {
    return this.media.list({ folderId, tag, favorite, q });
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: any) {
    return this.media.create(body);
  }

  // Declared before :id so "folders" isn't captured as an id param.
  @Get("folders")
  listFolders() {
    return this.media.listFolders();
  }

  @Post("folders")
  @HttpCode(201)
  createFolder(@Body() body: any) {
    return this.media.createFolder(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: any) {
    return this.media.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.media.remove(id);
  }
}
