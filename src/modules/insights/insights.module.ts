import { Module } from "@nestjs/common";
import { InsightsController } from "./insights.controller";
import { InsightsService } from "./insights.service";
import { SocialSyncService } from "./social-sync.service";

@Module({
  controllers: [InsightsController],
  providers: [InsightsService, SocialSyncService],
  exports: [SocialSyncService],
})
export class InsightsModule {}
