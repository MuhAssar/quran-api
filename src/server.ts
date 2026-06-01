import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { join } from 'node:path';
import { createApp } from './app';
import { openDatabases, getBookCodes } from './db';

// Path to the bundled athkar.zip download. Lives outside the repo
// (../../assets relative to the repo root); override with ATHKAR_ZIP_PATH.
const ATHKAR_ZIP_PATH =
  process.env.ATHKAR_ZIP_PATH ||
  join(__dirname, '..', '..', '..', 'assets', 'athkar.zip');

async function main() {
  const { files } = await openDatabases([
    __dirname,
    join(__dirname, '..'),
  ]);
  console.log('databases:', files);
  console.log('book codes loaded:', getBookCodes().size);

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

  // Static download: serve the athkar.zip asset (Node-only; uses node:fs).
  // serveStatic handles range requests, Content-Length, and HEAD.
  app.get(
    '/athkar.zip',
    serveStatic({
      path: ATHKAR_ZIP_PATH,
      onFound: (_path, c) => {
        c.header('Cache-Control', 'public, max-age=86400');
        c.header('Content-Disposition', 'attachment; filename="athkar.zip"');
      },
    }),
  );

  const port = Number(process.env.PORT) || 3000;
  const hostname = process.env.HOST || '0.0.0.0';

  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`Application is running on: http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  console.error('bootstrap failed:', err);
  process.exit(1);
});
