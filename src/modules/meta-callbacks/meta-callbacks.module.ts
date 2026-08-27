import { Module } from "@nestjs/common";
import { MetaCallbacksController } from "./meta-callbacks.controller";
import { MetaCallbacksService } from "./meta-callbacks.service";

@Module({ controllers: [MetaCallbacksController], providers: [MetaCallbacksService] })
export class MetaCallbacksModule {}
