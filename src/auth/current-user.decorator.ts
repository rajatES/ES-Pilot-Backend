import { createParamDecorator, ExecutionContext } from "@nestjs/common";

// Injects the verified Supabase auth user attached by SupabaseAuthGuard.
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().user;
});

// Injects the app profile row (display name / role / division) for the verified
// user — the equivalent of the old getCurrentProfile() return value.
export const CurrentProfile = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().profile;
});
