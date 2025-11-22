import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from './settings';

function getDbFiles(path: string): string[] {
  return readdirSync(path, {
    recursive: false,
    encoding: 'utf8',
  }).filter((file) => file.endsWith('.db'));
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: '*' });

  let dbFiles = getDbFiles(join(__dirname));

  if (dbFiles.length === 0) {
    dbFiles = dbFiles = getDbFiles(join(__dirname, '..'));
  }

  settings.DB_INDEX = dbFiles.find((file) => file.startsWith('index'));
  settings.DB_FARSH = dbFiles.find((file) => file.startsWith('farsh'));
  settings.DB_DATA = dbFiles.find((file) => file.startsWith('data'));
  settings.DB_WORDS = dbFiles.find((file) => file.startsWith('words'));

  console.log(settings);

  if (!settings.DB_DATA) {
    console.error('missing DB_DATA file!');
    return;
  }

  if (!settings.DB_INDEX) {
    console.error('missing DB_INDEX file!');
    return;
  }

  if (!settings.DB_FARSH) {
    console.warn('missing DB_FARSH file!');
  }

  await app.listen(3000);
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();
