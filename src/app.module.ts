import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { APP_GUARD } from "@nestjs/core";
import { DatabaseModule } from "./database/database.module";
import { SupabaseModule } from "./supabase/supabase.module";
import { AuthCoreModule } from "./auth/auth-core.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { HealthController } from "./health.controller";
import { PostsModule } from "./modules/posts/posts.module";
import { MeModule } from "./modules/me/me.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { TemplatesModule } from "./modules/templates/templates.module";
import { SearchModule } from "./modules/search/search.module";
import { AiModule } from "./modules/ai/ai.module";
import { AccountsModule } from "./modules/accounts/accounts.module";
import { MediaModule } from "./modules/media/media.module";
import { TeamModule } from "./modules/team/team.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { ApprovalsModule } from "./modules/approvals/approvals.module";
import { PublishNowModule } from "./modules/publish-now/publish-now.module";
import { SignupModule } from "./modules/signup/signup.module";
import { ComplianceModule } from "./modules/compliance/compliance.module";
import { UploadModule } from "./modules/upload/upload.module";
import { CanvaModule } from "./modules/canva/canva.module";
import { SocialModule } from "./modules/social/social.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CronModule } from "./modules/cron/cron.module";
import { QueuesModule } from "./modules/queues/queues.module";

@Module({
  imports: [
    // Loads .env from the backend/ directory into process.env for the whole app.
    ConfigModule.forRoot({ isGlobal: true }),
    // Enables @Cron() jobs (used by the ported cron tasks in Phase 4).
    ScheduleModule.forRoot(),
    // Postgres (Docker) — the schema now lives in database/entities.ts.
    DatabaseModule,
    // SupabaseModule now exports the Postgres-backed data client (the name is
    // retained so the 25 services that inject it don't all need editing).
    SupabaseModule,
    // Local JWT auth (login + user management), replaces Supabase Auth.
    AuthCoreModule,
    // Feature modules (posts, accounts, media, ...) are added here in Phase 4.
    PostsModule,
    MeModule,
    SettingsModule,
    NotificationsModule,
    TemplatesModule,
    SearchModule,
    AiModule,
    AccountsModule,
    MediaModule,
    TeamModule,
    DashboardModule,
    ApprovalsModule,
    PublishNowModule,
    SignupModule,
    ComplianceModule,
    UploadModule,
    CanvaModule,
    SocialModule,
    AuthModule,
    CronModule,
    QueuesModule,
  ],
  controllers: [HealthController],
  providers: [
    // Applied to every route; @Public() opts individual routes out.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
