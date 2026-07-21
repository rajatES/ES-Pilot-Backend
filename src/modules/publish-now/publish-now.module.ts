import { Module } from "@nestjs/common";
import { PublishNowController } from "./publish-now.controller";
import { PublishNowService } from "./publish-now.service";

@Module({ controllers: [PublishNowController], providers: [PublishNowService] })
export class PublishNowModule {}
