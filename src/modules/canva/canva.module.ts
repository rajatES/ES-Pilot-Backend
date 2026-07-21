import { Module } from "@nestjs/common";
import { CanvaController } from "./canva.controller";
import { CanvaService } from "./canva.service";

@Module({ controllers: [CanvaController], providers: [CanvaService] })
export class CanvaModule {}
