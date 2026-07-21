import { Global, Module } from "@nestjs/common";
import { SupabaseService } from "./supabase.service";

// Global so every feature module can inject SupabaseService without re-importing.
@Global()
@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
