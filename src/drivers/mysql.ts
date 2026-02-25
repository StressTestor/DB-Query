import type { DatabaseDriver, QueryResult, TableInfo, ColumnInfo } from "./base.js";
import { expandEnv } from "../config.js";

export class MysqlDriver implements DatabaseDriver {
  readonly driverName = "mysql";
  private pool: any = null;
  private connString: string;

  constructor(connectionString: string) {
    this.connString = connectionString;
  }

  async connect(): Promise<void> {
    let mysql2: any;
    try {
      // @ts-ignore — mysql2 is an optional peer dependency
      mysql2 = await import("mysql2/promise");
    } catch {
      try {
        // @ts-ignore — mysql2 is an optional peer dependency
        mysql2 = await import("mysql2");
        mysql2 = mysql2.default?.promise ?? mysql2.promise;
      } catch {
        throw new Error(
          "The 'mysql2' package is not installed. Run: npm install mysql2\n" +
          "It's listed as an optional peerDependency — only needed if you use the mysql driver."
        );
      }
    }

    const resolved = expandEnv(this.connString);
    const createPool = mysql2.default?.createPool ?? mysql2.createPool;
    this.pool = createPool({ uri: resolved, connectionLimit: 3 });

    // Test the connection
    try {
      const conn = await this.pool.getConnection();
      conn.release();
    } catch (e: any) {
      await this.pool.end().catch(() => {});
      this.pool = null;
      const msg = e.message ?? String(e);
      if (msg.includes("ECONNREFUSED")) {
        throw new Error(`Cannot connect to MySQL — connection refused. Is the server running? Check host/port.`);
      }
      if (msg.includes("Access denied")) {
        throw new Error(`MySQL access denied — wrong username or password. Check your connection string credentials.`);
      }
      if (msg.includes("Unknown database")) {
        throw new Error(`MySQL database not found. ${msg}`);
      }
      throw new Error(`MySQL connection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async query(sql: string, limit: number, timeoutMs: number): Promise<QueryResult> {
    this.ensureConnected();

    let wrappedSql = sql;
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith("SELECT") || upper.startsWith("WITH")) {
      const stripped = sql.replace(/;\s*$/, "");
      wrappedSql = `SELECT * FROM (${stripped}) AS _q LIMIT ${limit}`;
    }

    const [rows] = await this.pool.query({ sql: wrappedSql, timeout: timeoutMs });

    if (!Array.isArray(rows)) {
      return { rows: [], rowCount: (rows as any)?.affectedRows ?? 0 };
    }

    return {
      rows: (rows as Record<string, unknown>[]).slice(0, limit),
      rowCount: rows.length,
    };
  }

  async listTables(): Promise<TableInfo[]> {
    this.ensureConnected();
    const [rows] = await this.pool.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
       ORDER BY TABLE_NAME`
    );
    return (rows as any[]).map(r => ({
      name: r.name,
      type: r.type === "BASE TABLE" ? "table" : r.type.toLowerCase(),
    }));
  }

  async describeTable(table: string): Promise<ColumnInfo[]> {
    this.ensureConnected();

    const [rows] = await this.pool.query(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [table]
    );

    if ((rows as any[]).length === 0) {
      throw new Error(`Table "${table}" not found.`);
    }

    return (rows as any[]).map(r => ({
      name: r.COLUMN_NAME,
      type: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === "YES",
      defaultValue: r.COLUMN_DEFAULT,
      primaryKey: r.COLUMN_KEY === "PRI",
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
    if (!this.pool) throw new Error("MySQL not connected. Call connect() first.");
  }
}
