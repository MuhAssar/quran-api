import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  getFromDB(sql: string, dbFile: string): string[] {
    if (!sql) {
      return [];
    }

    const readOnly = true;
    const db = new DatabaseSync(dbFile, { readOnly });
    try {
      if (!readOnly) {
        db.exec('PRAGMA journal_mode = WAL');
      }
    } catch (err) {
      db.close();
      throw new BadRequestException(`${err.code}: ${err.message}\n`);
    }

    let rows = [];
    try {
      const stmt = db.prepare(sql);

      if (sql.trim().toLowerCase().startsWith('select')) {
        rows = stmt.all();
      } else {
        stmt.run();
      }
    } catch (err) {
      db.close();
      throw new BadRequestException(`${err.code}: ${err.message}\n`);
    }

    db.close();
    return rows;
  }
}
