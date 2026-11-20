import type { ServiceVersions } from "@lotso-trading/shared";
import { Controller, Get } from "@nestjs/common";
import { SystemService } from "./system.service.ts";

@Controller("system")
export class SystemController {
    constructor(private readonly systemService: SystemService) {}

    @Get("versions")
    getVersions(): ServiceVersions {
        return this.systemService.getVersions();
    }
}
