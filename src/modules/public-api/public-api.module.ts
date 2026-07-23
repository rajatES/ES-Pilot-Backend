import { Module } from "@nestjs/common";
import { PublicApiController } from "./public-api.controller";
import { PublicApiService } from "./public-api.service";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { PostsModule } from "../posts/posts.module";
import { UploadModule } from "../upload/upload.module";

// External Developer API (key-authenticated /api/v1/*). Reuses the app's
// posting pipeline (PostsModule) and S3 upload (UploadModule).
@Module({
  imports: [ApiKeysModule, PostsModule, UploadModule],
  controllers: [PublicApiController],
  providers: [PublicApiService, ApiKeyGuard],
})
export class PublicApiModule {}
