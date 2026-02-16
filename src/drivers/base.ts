export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** total rows available before LIMIT was applied, if known */
  totalAvailable?: number;
}

export interface TableInfo {
  name: string;
  type: string; // "table", "view", etc.
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
}

export interface DatabaseDriver {
  /** Human-readable driver name */
  readonly driverName: string;

  /** Connect to the database. Throws on failure with helpful message. */
  connect(): Promise<void>;

  /** Run a query with optional row limit and timeout. */
  query(sql: string, limit: number, timeoutMs: number): Promise<QueryResult>;

  /** List all tables (and views). */
  listTables(): Promise<TableInfo[]>;

  /** Describe columns for a specific table. */
  describeTable(table: string): Promise<ColumnInfo[]>;

  /** Test if the connection is alive. */
  ping(): Promise<boolean>;

  /** Close the connection. */
  close(): Promise<void>;
}
