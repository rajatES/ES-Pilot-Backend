import { Module } from "@nestjs/common";
import { PostizController } from "./postiz.controller";
import { PostizService } from "./postiz.service";

@Module({ controllers: [PostizController], providers: [PostizService] })
export class PostizModule {}
