import { Module } from "@nestjs/common";
import { PostsController } from "./posts.controller";
import { PostsService } from "./posts.service";
import { QueuesModule } from "../queues/queues.module";

@Module({
  imports: [QueuesModule],
  controllers: [PostsController],
  providers: [PostsService],
})
export class PostsModule {}
