import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { QueuesService } from "./queues.service";

@Controller("queues")
export class QueuesController {
  constructor(private readonly queues: QueuesService) {}

  // GET /api/queues — every account's slots + the workspace timezone.
  @Get()
  list() {
    return this.queues.list();
  }

  // PUT /api/queues/:accountId — replace that account's weekly slot grid.
  @Put(":accountId")
  replace(@Param("accountId") accountId: string, @Body() body: any) {
    return this.queues.replaceForAccount(accountId, body?.slots);
  }
}
