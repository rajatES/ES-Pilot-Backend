import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { PublicApiService } from "./public-api.service";
import { ApiKeyGuard } from "./api-key.guard";
import { Public } from "../../auth/public.decorator";
import { CurrentProfile } from "../../auth/current-user.decorator";

// External Developer API — /api/v1/*. @Public() opts out of the global JWT
// guard; ApiKeyGuard authenticates with a key from Settings → API Keys.
// Docs: README-api.md at the repo root.
@Public()
@UseGuards(ApiKeyGuard)
@Controller("v1")
export class PublicApiController {
  constructor(private readonly api: PublicApiService) {}

  // GET /api/v1/accounts — connected pages/accounts and their IDs.
  @Get("accounts")
  listAccounts() {
    return this.api.listAccounts();
  }

  // POST /api/v1/posts — create a post (publish now / schedule / queue / review / draft).
  @Post("posts")
  @HttpCode(201)
  createPost(@Body() body: any, @CurrentProfile() profile: any) {
    return this.api.createPost(body, profile);
  }

  // GET /api/v1/posts — recent posts with per-account delivery status.
  @Get("posts")
  listPosts(@Query() query: any) {
    return this.api.listPosts(query);
  }

  // GET /api/v1/posts/:id
  @Get("posts/:id")
  getPost(@Param("id") id: string) {
    return this.api.getPost(id);
  }

  // DELETE /api/v1/posts/:id — cancel/remove (blocked while publishing).
  @Delete("posts/:id")
  deletePost(@Param("id") id: string) {
    return this.api.deletePost(id);
  }

  // POST /api/v1/media — multipart "file", or JSON { url } to import; returns
  // a public S3 URL usable in POST /v1/posts media.
  @Post("media")
  @HttpCode(201)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 200 * 1024 * 1024 } }))
  uploadMedia(@UploadedFile() file: any, @Body() body: any) {
    return this.api.uploadMedia(file, body);
  }
}
