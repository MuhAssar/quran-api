import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { createApp } from './app';
import { openDatabases } from './db';

const { files } = openDatabases([__dirname, join(__dirname, '..')]);
console.log('databases:', files);

if (!files.data) {
  console.error('missing DB_DATA file!');
  process.exit(1);
}
if (!files.index) {
  console.error('missing DB_INDEX file!');
  process.exit(1);
}
if (!files.farsh) {
  console.warn('missing DB_FARSH file!');
}

const app = createApp();
const port = Number(process.env.PORT) || 3000;
const hostname = process.env.HOST || '0.0.0.0';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Application is running on: http://localhost:${info.port}`);
});
