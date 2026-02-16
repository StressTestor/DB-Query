import type { DatabaseDriver, QueryResult, TableInfo, ColumnInfo } from "./base.js";
import { resolvePath } from "../config.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class SqliteDriver implements DatabaseDriver {
  readonly driverName = "sqlite";
  private db: any = null;
  private dbPath: string;
  private createIfMissing: boolean;

  constructor(path: string, createIfMissing = true) {
    this.dbPath = resolvePath(path);
    this.createIfMissing = createIfMissing;
  }

  async connect(): Promise<void> {
    try {
      // node:sqlite is built into Node 22+
      const { DatabaseSync } = await import("node:sqlite" as string);

      if (!this.createIfMissing && !existsSync(this.dbPath)) {
        throw new Error(`Database file not found: ${this.dbPath}. Set createIfMissing in config or create the file first.`);
      }

      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
    } catch (e: any) {
      if (e.code === "ERR_MODULE_NOT_FOUND" || e.message?.includes("Cannot find module")) {
        throw new Error("node:sqlite requires Node.js 22 or later. Upgrade Node to use the sqlite driver.");
      }
      throw new Error(`Failed to open SQLite database at ${this.dbPath}: ${e.message}`);
    }
  }

  async query(sql: string, limit: number, _timeoutMs: number): Promise<QueryResult> {
    this.ensureConnected();

    // NOTE: DatabaseSync is synchronous and does not support query timeouts.
    // A real timeout would require worker_threads, which is out of scope for now.
    // As a basic DoS prevention, reject very large queries.
    if (sql.length > 10_000) {
      throw new Error("Query too long — SQLite queries are limited to 10,000 characters as a DoS safeguard.");
    }
    if (_timeoutMs > 0) {
      console.warn("db-query: SQLite driver does not enforce query timeouts (DatabaseSync is synchronous). Consider using postgres or mysql for timeout support.");
    }

    // Wrap with LIMIT if it looks like a SELECT and doesn't already have one
    let wrappedSql = sql;
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith("SELECT") && !upper.includes("LIMIT")) {
      wrappedSql = `${sql.replace(/;\s*$/, "")} LIMIT ${limit + 1}`;
    }

    const stmt = this.db.prepare(wrappedSql);
    let rows: Record<string, unknown>[];

    if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA") || upper.startsWith("EXPLAIN") || upper.startsWith("WITH")) {
      rows = stmt.all() as Record<string, unknown>[];
    } else {
      const result = stmt.run();
      return {
        rows: [],
        rowCount: 0,
        totalAvailable: result.changes ?? 0,
      };
    }

    const totalAvailable = rows.length > limit ? undefined : rows.length;
    const limited = rows.slice(0, limit);

    return {
      rows: limited,
      rowCount: limited.length,
      totalAvailable: rows.length > limit ? rows.length : totalAvailable,
    };
  }

  async listTables(): Promise<TableInfo[]> {
    this.ensureConnected();
    const stmt = this.db.prepare(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const rows = stmt.all() as { name: string; type: string }[];
    return rows.map(r => ({ name: r.name, type: r.type }));
  }

  async describeTable(table: string): Promise<ColumnInfo[]> {
    this.ensureConnected();
    const stmt = this.db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`);
    const rows = stmt.all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];

    if (rows.length === 0) {
      throw new Error(`Table "${table}" not found.`);
    }

    return rows.map(r => ({
      name: r.name,
      type: r.type || "ANY",
      nullable: r.notnull === 0,
      defaultValue: r.dflt_value,
      primaryKey: r.pk > 0,
    }));
  }

  async ping(): Promise<boolean> {
    try {
      this.ensureConnected();
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureConnected(): void {
    if (!this.db) throw new Error("SQLite database not connected. Call connect() first.");
  }
}
