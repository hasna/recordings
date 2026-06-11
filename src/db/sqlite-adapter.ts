import { Database } from "bun:sqlite";

export class SqliteAdapter {
  readonly raw: Database;

  constructor(path: string) {
    this.raw = new Database(path, { create: true });
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const result = this.raw.prepare(sql).run(...flat as any[]);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  get(sql: string, ...params: unknown[]): unknown {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return this.raw.prepare(sql).get(...flat as any[]);
  }

  all(sql: string, ...params: unknown[]): unknown[] {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return this.raw.prepare(sql).all(...flat as any[]);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  close(): void {
    this.raw.close();
  }
}
