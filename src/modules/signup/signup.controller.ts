import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { SignupService } from "./signup.service";
import { Public } from "../../auth/public.decorator";

@Controller("signup")
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Public()
  @Post()
  @HttpCode(201)
  run(@Body() body: any) {
    return this.signup.signup(body);
  }
}
