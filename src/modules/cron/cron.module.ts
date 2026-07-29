import { Module } from "@nestjs/common";
import { CronController } from "./cron.controller";
import { CronService } from "./cron.service";
import { ApprovalsModule } from "../approvals/approvals.module";

@Module({ imports: [ApprovalsModule], controllers: [CronController], providers: [CronService] })
export class CronModule {}
