import { Module } from "@nestjs/common";
import { PostsController } from "./posts.controller";
import { PostsService } from "./posts.service";
import { QueuesModule } from "../queues/queues.module";

@Module({
  imports: [QueuesModule],
  controllers: [PostsController],
  providers: [PostsService],
  // Exported for the external v1 API (modules/public-api), which delegates
  // post creation here so both surfaces share one publishing pipeline.
  exports: [PostsService],
})
export class PostsModule {}
