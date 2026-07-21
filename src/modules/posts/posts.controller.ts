import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { PostsService } from "./posts.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("posts")
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  // GET /api/posts — accounts + recent posts + authors for the composer/calendar.
  @Get()
  list() {
    return this.posts.list();
  }

  // POST /api/posts — create a draft/review, or schedule/publish to each Page.
  @Post()
  @HttpCode(201)
  create(@Body() body: any, @CurrentProfile() profile: any) {
    return this.posts.create(body, profile);
  }

  // POST /api/posts/bulk — delete or reschedule many posts.
  @Post("bulk")
  bulk(@Body() body: any) {
    return this.posts.bulk(body);
  }

  // POST /api/posts/import — bulk CSV import.
  @Post("import")
  importCsv(@Body() body: any, @CurrentProfile() profile: any) {
    return this.posts.importCsv(body, profile);
  }

  // POST /api/posts/recycle — clone a post back into the queue.
  @Post("recycle")
  @HttpCode(201)
  recycle(@Body() body: any, @CurrentProfile() profile: any) {
    return this.posts.recycle(body, profile);
  }

  // POST /api/posts/verify — reconcile recent posts against Facebook.
  @Post("verify")
  verify() {
    return this.posts.verify();
  }

  // PATCH /api/posts/:id — edit caption / link / schedule time.
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: any) {
    return this.posts.update(id, body);
  }

  // DELETE /api/posts/:id
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.posts.remove(id);
  }
}
