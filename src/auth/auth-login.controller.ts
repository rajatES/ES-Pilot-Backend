import { Body, Controller, Post } from "@nestjs/common";
import { AuthCoreService } from "./auth-core.service";
import { Public } from "./public.decorator";

// Local email/password login → JWT. (OAuth connect flows for the social
// platforms live in modules/auth under the same /api/auth prefix.)
@Controller("auth")
export class AuthLoginController {
  constructor(private readonly auth: AuthCoreService) {}

  // POST /api/auth/login { email, password } → { token, profile }
  @Public()
  @Post("login")
  login(@Body() body: { email: string; password: string }) {
    return this.auth.login(body?.email, body?.password);
  }
}
