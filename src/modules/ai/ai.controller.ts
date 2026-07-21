import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
// Ported plain-JS content assistant (allowJs).
import { runAi } from "../../lib/ai";

@Controller("ai")
export class AiController {
  // POST /api/ai — content assistant (free local helpers today).
  @Post()
  run(@Body() body: any) {
    const out = runAi(body);
    if (out.error) throw new BadRequestException(out.error);
    return { ...out, mode: "free" };
  }
}
