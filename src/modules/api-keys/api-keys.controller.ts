import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { ApiKeysService } from "./api-keys.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

// Management surface for Developer API keys — JWT-protected (Settings UI),
// admin-only (enforced in the service). The external v1 API itself lives in
// modules/public-api and authenticates with the keys minted here.
@Controller("api-keys")
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  // GET /api/api-keys
  @Get()
  list(@CurrentProfile() me: any) {
    return this.apiKeys.list(me);
  }

  // GET /api/api-keys/usage — per-key post-creation rollups (admin-only).
  @Get("usage")
  usage(@CurrentProfile() me: any) {
    return this.apiKeys.usage(me);
  }

  // GET /api/api-keys/activity — API-created posts + usage rollups (admin-only).
  @Get("activity")
  activity(@CurrentProfile() me: any, @Query() query: any) {
    return this.apiKeys.activity(me, query);
  }

  // POST /api/api-keys — returns { ...key, key: "pp_live_…" } exactly once.
  @Post()
  @HttpCode(201)
  create(@Body() body: any, @CurrentProfile() me: any) {
    return this.apiKeys.create(body, me);
  }

  // DELETE /api/api-keys/:id — revoke.
  @Delete(":id")
  revoke(@Param("id") id: string, @CurrentProfile() me: any) {
    return this.apiKeys.revoke(id, me);
  }
}
