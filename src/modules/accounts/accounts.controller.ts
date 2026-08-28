import { Body, Controller, Delete, Param, Patch, Post } from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import { CurrentProfile } from "../../auth/current-user.decorator";

@Controller("accounts")
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  // POST /api/accounts/bulk — category, lock/unlock, or disconnect for many.
  @Post("bulk")
  bulk(@Body() body: any, @CurrentProfile() profile: any) {
    return this.accounts.bulk(body, profile);
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

  // PATCH /api/accounts/:id — manual category override, and { locked } to lock
  // or unlock the page (stops posting without disconnecting it).
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: any, @CurrentProfile() profile: any) {
    return this.accounts.update(id, body, profile);
  }

  // DELETE /api/accounts/:id
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.accounts.remove(id);
  }
}
