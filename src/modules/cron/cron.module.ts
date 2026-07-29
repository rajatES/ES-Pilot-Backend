import { Module } from "@nestjs/common";
import { CronController } from "./cron.controller";
import { CronService } from "./cron.service";
import { ApprovalsModule } from "../approvals/approvals.module";
import { InsightsModule } from "../insights/insights.module";

@Module({ imports: [ApprovalsModule, InsightsModule], controllers: [CronController], providers: [CronService] })
export class CronModule {}
