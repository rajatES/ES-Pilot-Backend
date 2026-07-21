import { Body, Controller, Get, Put } from "@nestjs/common";
import { SettingsService } from "./settings.service";

@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  // The whole request body IS the settings value object (matches the original PUT).
  @Put()
  update(@Body() body: any) {
    return this.settings.update(body);
  }
}
