import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { TeamService } from "./team.service";
import { CurrentProfile } from "../../auth/current-user.decorator";
import { Public } from "../../auth/public.decorator";

@Controller("team")
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  list(@CurrentProfile() me: any) {
    return this.team.list(me);
  }

  @Post()
  @HttpCode(201)
  create(@CurrentProfile() me: any, @Body() body: any) {
    return this.team.create(me, body);
  }

  // Public: login page checks whether to show the bootstrap form.
  @Public()
  @Get("exists")
  exists() {
    return this.team.exists();
  }

  // Public, one-time: create the first admin seat.
  @Public()
  @Post("bootstrap")
  @HttpCode(201)
  bootstrap(@Body() body: any) {
    return this.team.bootstrap(body);
  }

  @Get("stats")
  stats(
    @CurrentProfile() me: any,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("divisionId") divisionId?: string,
  ) {
    return this.team.stats(me, { from, to, divisionId });
  }

  @Post("bulk")
  bulk(@CurrentProfile() me: any) {
    return this.team.bulk(me);
  }

  @Patch(":id")
  update(@CurrentProfile() me: any, @Param("id") id: string, @Body() body: any) {
    return this.team.update(me, id, body);
  }

  @Delete(":id")
  remove(@CurrentProfile() me: any, @Param("id") id: string) {
    return this.team.remove(me, id);
  }
}
