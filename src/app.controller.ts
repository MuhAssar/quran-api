import { Controller, Get, Query } from '@nestjs/common';
import { AppService } from './app.service';
import { settings } from './settings';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('i')
  getIndex(@Query('sql') sql: string): string[] {
    return this.appService.getFromDB(sql, settings.DB_INDEX);
  }

  @Get('d')
  getData(@Query('sql') sql: string): string[] {
    return this.appService.getFromDB(sql, settings.DB_DATA);
  }

  @Get('f')
  getFarsh(@Query('sql') sql: string): string[] {
    return this.appService.getFromDB(sql, settings.DB_FARSH);
  }

  @Get('w')
  getWords(@Query('sql') sql: string): string[] {
    return this.appService.getFromDB(sql, settings.DB_WORDS);
  }
}
