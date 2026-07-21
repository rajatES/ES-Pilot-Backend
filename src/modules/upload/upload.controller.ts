import { Controller, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { UploadService } from "./upload.service";

@Controller("upload")
export class UploadController {
  constructor(private readonly upload: UploadService) {}

  // multipart/form-data with a single "file" field (memory storage → file.buffer).
  // 200 MB cap accommodates video uploads (FB/IG/Threads all accept mp4 well
  // under that); images are unaffected.
  @Post()
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 200 * 1024 * 1024 } }))
  run(@UploadedFile() file: any) {
    return this.upload.upload(file);
  }
}
