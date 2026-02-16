import type { DatabaseDriver, QueryResult, TableInfo, ColumnInfo } from "./base.js";
import { expandEnv } from "../config.js";

export class PostgresDriver implements DatabaseDriver {
  readonly driverName = "postgres";
  private pool: any = null;
  private connString: string;

  constructor(connectionString: string) {
    this.connString = connectionString;
  }

  async connect(): Promise<void> {
    let pg: any;
    try {
      pg = await import("pg");
    } catch {
      throw new Error(
        "The 'pg' package is not installed. Run: npm install pg\n" +
        "It's listed as an optional peerDependency — only needed if you use the postgres driver."
      );
    }

    const resolved = expandEnv(this.connString);
    const Pool = pg.default?.Pool ?? pg.Pool;
    this.pool = new Pool({ connectionString: resolved, max: 3 });

    // Test the connection
    try {
      const client = await this.pool.connect();
      client.release();
    } catch (e: any) {
      await this.pool.end().catch(() => {});
      this.pool = null;
      const msg = e.message ?? String(e);
      if (msg.includes("ECONNREFUSED")) {
        throw new Error(`Cannot connect to PostgreSQL — connection refused. Is the server running? Check host/port in your connection string.`);
      }
      if (msg.includes("password authentication failed")) {
        throw new Error(`PostgreSQL authentication failed — wrong password. Check your connection string credentials.`);
      }
      if (msg.includes("does not exist")) {
        throw new Error(`PostgreSQL database not found. ${msg}`);
      }
      throw new Error(`PostgreSQL connection failed: ${msg}`);
    }
  }

  async query(sql: string, limit: number, timeoutMs: number): Promise<QueryResult> {
    this.ensureConnected();

    let wrappedSql = sql;
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith("SELECT") && !upper.includes("LIMIT")) {
      wrappedSql = `${sql.replace(/;\s*$/, "")} LIMIT ${limit}`;
    }

    const result = await this.pool.query({
      text: wrappedSql,
      statement_timeout: timeoutMs,
    });

    if (!result.rows) {
      return { rows: [], rowCount: result.rowCount ?? 0 };
    }

    return {
      rows: result.rows.slice(0, limit),
      rowCount: result.rows.length,
      totalAvailable: result.rowCount ?? undefined,
    };
  }

  async listTables(): Promise<TableInfo[]> {
    this.ensureConnected();
    const result = await this.pool.query(
      `SELECT table_name AS name, table_type AS type
       FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`
    );
    return result.rows.map((r: any) => ({
      name: r.name,
      type: r.type === "BASE TABLE" ? "table" : r.type.toLowerCase(),
    }));
  }

  async describeTable(table: string): Promise<ColumnInfo[]> {
    this.ensureConnected();

    // Get columns
    const colResult = await this.pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );

    if (colResult.rows.length === 0) {
      throw new Error(`Table "${table}" not found in public schema.`);
    }

    // Get primary key columns
    const pkResult = await this.pool.query(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [table]
    );
    const pkCols = new Set(pkResult.rows.map((r: any) => r.attname));

    return colResult.rows.map((r: any) => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === "YES",
      defaultValue: r.column_default,
      primaryKey: pkCols.has(r.column_name),
    }));
  }

  async ping(): Promise<boolean> {
    try {
      this.ensureConnected();
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private ensureConnected(): void {
    if (!this.pool) throw new Error("PostgreSQL not connected. Call connect() first.");
  }
}
