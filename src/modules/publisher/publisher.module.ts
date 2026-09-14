import { Module } from "@nestjs/common";
import { PublisherService } from "./publisher.service";

// Exported to both CronModule (/api/cron/publish) and PostsModule
// (/api/posts/retry) so the queue dispatch lives in exactly one place.
@Module({ providers: [PublisherService], exports: [PublisherService] })
export class PublisherModule {}
