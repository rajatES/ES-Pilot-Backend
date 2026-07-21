import { Body, Controller, Delete, Param, Patch, Post } from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("accounts")
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  // POST /api/accounts/bulk — category change or disconnect for many accounts.
  @Post("bulk")
  bulk(@Body() body: any) {
    return this.accounts.bulk(body);
  }

  // POST /api/accounts/disconnect — remove all Pages connected via one FB account.
  @Post("disconnect")
  disconnect(@Body() body: any, @CurrentProfile() profile: any) {
    return this.accounts.disconnect(profile, body?.fbUserId);
  }

  // POST /api/accounts/sync — refresh follower/like/token health.
  @Post("sync")
  sync(@Body() body: any) {
    return this.accounts.sync(body);
  }

  // PATCH /api/accounts/:id — manual category override.
  @Patch(":id")
  updateCategory(@Param("id") id: string, @Body() body: any) {
    return this.accounts.updateCategory(id, body?.category);
  }

  // DELETE /api/accounts/:id
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.accounts.remove(id);
  }
}
