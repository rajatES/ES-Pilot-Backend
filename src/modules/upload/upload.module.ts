import { Module } from "@nestjs/common";
import { UploadController } from "./upload.controller";
import { UploadService } from "./upload.service";

// UploadService is exported for the external v1 API's media endpoint.
@Module({ controllers: [UploadController], providers: [UploadService], exports: [UploadService] })
export class UploadModule {}
