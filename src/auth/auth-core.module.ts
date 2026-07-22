import { Global, Module } from "@nestjs/common";
import { AuthCoreService } from "./auth-core.service";
import { AuthLoginController } from "./auth-login.controller";

// Global so the guard and any service can inject AuthCoreService for user
// management (create/delete/setPassword) without re-importing.
@Global()
@Module({
  controllers: [AuthLoginController],
  providers: [AuthCoreService],
  exports: [AuthCoreService],
})
export class AuthCoreModule {}
