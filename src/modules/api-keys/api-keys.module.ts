import { Module } from "@nestjs/common";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysService } from "./api-keys.service";

// Exported so PublicApiModule's ApiKeyGuard can validate presented keys.
@Module({ controllers: [ApiKeysController], providers: [ApiKeysService], exports: [ApiKeysService] })
export class ApiKeysModule {}
