import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { PublicApiService } from "./public-api.service";
import { ApiKeyGuard } from "./api-key.guard";
import { Public } from "../../auth/public.decorator";
import { CurrentProfile, CurrentApiKey } from "../../auth/current-user.decorator";

// External Developer API — /api/v1/*. @Public() opts out of the global JWT
// guard; ApiKeyGuard authenticates with a key from Settings → API Keys.
// Docs: README-api.md at the repo root.
@Public()
@UseGuards(ApiKeyGuard)
@Controller("v1")
export class PublicApiController {
  constructor(private readonly api: PublicApiService) {}

  // GET /api/v1/accounts — connected pages/accounts and their IDs.
  //
  // `?include=automation` attaches each page's automation config;
  // `?automationEnabled=true` returns only the pages opted in to automation —
  // which is the list a content pipeline should actually iterate, so that
  // "which pages do I run for?" is answered by the server rather than by a
  // client-side filter somebody can forget.
  @Get("accounts")
  listAccounts(@Query() query: any) {
    return this.api.listAccounts(query);
  }

  // GET /api/v1/accounts/:id/automation — the page's editorial brief:
  // entities, listening sources, caption DNA, card styling, posting budget.
  // `null` when the page has not been set up for automation.
  @Get("accounts/:id/automation")
  getAutomation(@Param("id") id: string) {
    return this.api.getAutomation(id);
  }

  // PUT /api/v1/accounts/:id/automation — create or REPLACE that brief.
  // Full replace, not a merge: an omitted field means "remove it", so an edit
  // that drops an entity is expressible. Send the whole object.
  @Put("accounts/:id/automation")
  putAutomation(@Param("id") id: string, @Body() body: any) {
    return this.api.putAutomation(id, body);
  }

  // GET /api/v1/accounts/:id/posts — every post on the page (organic +
  // app-published), for automations that need to see what a page actually
  // looks like before adding to it.
  @Get("accounts/:id/posts")
  listAccountPosts(@Param("id") id: string, @Query() query: any) {
    return this.api.listAccountPosts(id, query);
  }

  // POST /api/v1/posts — create a post (publish now / schedule / queue / review / draft).
  // Send an `Idempotency-Key` header to make a retry safe: the same key always
  // resolves to the same post instead of creating a second one.
  @Post("posts")
  @HttpCode(201)
  createPost(
    @Body() body: any,
    @CurrentProfile() profile: any,
    @CurrentApiKey() apiKey: any,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.api.createPost(body, profile, apiKey, idempotencyKey);
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
