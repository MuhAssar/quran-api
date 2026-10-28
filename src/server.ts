import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { join } from 'node:path';
import { createApp } from './app';
import { contentDbDirs, getPackKeys, openContentDbs } from './content-db';

// Path to the bundled athkar.zip download. Lives outside the repo
// (../../assets relative to the repo root); override with ATHKAR_ZIP_PATH.
const ATHKAR_ZIP_PATH =
  process.env.ATHKAR_ZIP_PATH ||
  join(__dirname, '..', '..', '..', 'assets', 'athkar.zip');

async function main() {
  const content = openContentDbs(contentDbDirs(join(__dirname, '..')));
  console.log(
    'content DBs:',
    content.source,
    `(${content.targets.length} targets)`,
  );
  console.log('book packs:', getPackKeys('book').size);
  if (!content.targets.includes('quran') && !process.env.DB_URL_TEMPLATE) {
    console.error(
      'missing quran_v*.db: set DB_DIR, build ../wursha-data (npm run build) or fetch the data in ../Wursha_QuranHolder',
    );
    process.exit(1);
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
