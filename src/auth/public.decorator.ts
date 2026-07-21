import { SetMetadata } from "@nestjs/common";

// Marks a route (or controller) as not requiring a logged-in user, so the global
// SupabaseAuthGuard lets it through. Used by cron jobs, OAuth callbacks, signup,
// and existence-check endpoints that authorize themselves.
export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
