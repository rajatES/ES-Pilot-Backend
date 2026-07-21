import { Module } from "@nestjs/common";
import { QueuesController } from "./queues.controller";
import { QueuesService } from "./queues.service";

@Module({
  controllers: [QueuesController],
  providers: [QueuesService],
  // Exported so PostsService can resolve "add to queue" into a concrete time.
  exports: [QueuesService],
})
export class QueuesModule {}
