import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { resolveConfig, type DbQueryConfig, type ConnectionConfig } from "./config.js";
import { validateQuery, isReadOnly } from "./safety.js";
import { formatResults, type OutputFormat } from "./format.js";
import type { DatabaseDriver } from "./drivers/base.js";
import { SqliteDriver } from "./drivers/sqlite.js";

let cfg: DbQueryConfig;
const drivers: Map<string, DatabaseDriver> = new Map();

async function createDriver(connCfg: ConnectionConfig): Promise<DatabaseDriver> {
  switch (connCfg.driver) {
    case "sqlite":
      return new SqliteDriver(connCfg.path ?? ":memory:");
    case "postgres": {
      const { PostgresDriver } = await import("./drivers/postgres.js");
      return new PostgresDriver(connCfg.connectionString ?? "");
    }
    case "mysql": {
      const { MysqlDriver } = await import("./drivers/mysql.js");
      return new MysqlDriver(connCfg.connectionString ?? "");
    }
    default:
      throw new Error(`Unknown driver: ${connCfg.driver}. Supported: sqlite, postgres, mysql`);
  }
}

async function getDriver(connectionName: string): Promise<DatabaseDriver> {
  const existing = drivers.get(connectionName);
  if (existing) return existing;

  const connCfg = cfg.connections[connectionName];
  if (!connCfg) {
    const available = Object.keys(cfg.connections);
    throw new Error(
      available.length > 0
        ? `Connection "${connectionName}" not found. Available: ${available.join(", ")}`
        : `No database connections configured. Add connections to the db-query plugin config.`
    );
  }

  const driver = await createDriver(connCfg);
  await driver.connect();
  drivers.set(connectionName, driver);
  return driver;
}

function resolveConnectionName(name?: string): string {
  if (name) return name;
  if (cfg.defaultConnection) return cfg.defaultConnection;
  const keys = Object.keys(cfg.connections);
  if (keys.length === 1) return keys[0];
  if (keys.length === 0) throw new Error("No database connections configured.");
  throw new Error(`Multiple connections available (${keys.join(", ")}). Specify which one to use.`);
}

function maskConnectionString(connCfg: ConnectionConfig): string {
  if (connCfg.driver === "sqlite") return connCfg.path ?? ":memory:";
  const raw = connCfg.connectionString ?? "";
  // Don't leak credentials — show driver + host at most
  if (raw.startsWith("$")) return raw; // env var reference, safe to show
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/${url.pathname.slice(1).split("/")[0] ?? ""}`;
  } catch {
    return "[configured]";
  }
}

const plugin = {
  id: "db-query",
  name: "Database Query Tool",
  description: "safe SQL execution for openclaw agents. postgres, mysql, sqlite. read-only by default.",

  register(api: OpenClawPluginApi) {
    cfg = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
    api.logger.info(`db-query: initialized with ${Object.keys(cfg.connections).length} connection(s)`);

    // ── Tools ─────────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "db_query",
        label: "Database Query",
        description:
          "Execute a SQL query against a configured database connection. Returns results as a formatted table, JSON, or CSV. " +
          "Read-only by default — INSERT/UPDATE/DELETE/DROP are blocked unless explicitly allowed in config.",
        parameters: Type.Object({
          query: Type.String({ description: "SQL query to execute" }),
          connection: Type.Optional(Type.String({ description: "Connection name from config (uses default if omitted)" })),
          format: Type.Optional(Type.Union([
            Type.Literal("table"),
            Type.Literal("json"),
            Type.Literal("csv"),
          ], { description: "Output format (default: table)" })),
          limit: Type.Optional(Type.Number({ description: "Max rows to return (default: 100, hard cap from config)" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const connName = resolveConnectionName(params.connection as string | undefined);
            const connCfg = cfg.connections[connName];
            const readOnly = isReadOnly(connCfg?.readOnly, cfg.allowMutations);
            const query = params.query as string;
            const format = (params.format as OutputFormat) ?? "table";
            const limit = Math.min((params.limit as number) ?? 100, cfg.maxRows);

            // Safety check
            const safety = validateQuery(query, !readOnly);
            if (!safety.allowed) {
              return { content: [{ type: "text" as const, text: safety.reason! }], details: null };
            }

            const driver = await getDriver(connName);
            const result = await driver.query(query, limit, cfg.queryTimeout);
            const output = formatResults(result.rows, format, result.totalAvailable);

            return { content: [{ type: "text" as const, text: output }], details: null };
          } catch (e: any) {
            return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: null };
          }
        },
      },
      { name: "db_query" }
    );

    api.registerTool(
      {
        name: "db_schema",
        label: "Database Schema",
        description:
          "Inspect database schema. List all tables, or describe a specific table's columns, types, and constraints.",
        parameters: Type.Object({
          connection: Type.Optional(Type.String({ description: "Connection name from config" })),
          table: Type.Optional(Type.String({ description: "Table name to describe. Omit to list all tables." })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const connName = resolveConnectionName(params.connection as string | undefined);
            const driver = await getDriver(connName);
            const table = params.table as string | undefined;

            if (table) {
              const columns = await driver.describeTable(table);
              const lines = [`Table: ${table}\n`];
              const maxName = Math.max(...columns.map(c => c.name.length), 4);
              const maxType = Math.max(...columns.map(c => c.type.length), 4);
              lines.push(`${"Column".padEnd(maxName)} | ${"Type".padEnd(maxType)} | Nullable | Default    | PK`);
              lines.push(`${"─".repeat(maxName)}─┼─${"─".repeat(maxType)}─┼──────────┼────────────┼────`);
              for (const col of columns) {
                lines.push(
                  `${col.name.padEnd(maxName)} | ${col.type.padEnd(maxType)} | ${col.nullable ? "YES     " : "NO      "} | ${(col.defaultValue ?? "").toString().padEnd(10).slice(0, 10)} | ${col.primaryKey ? "YES" : ""}`
                );
              }
              return { content: [{ type: "text" as const, text: lines.join("\n") }], details: null };
            } else {
              const tables = await driver.listTables();
              if (tables.length === 0) {
                return { content: [{ type: "text" as const, text: "No tables found." }], details: null };
              }
              const lines = [`Tables in "${connName}":\n`];
              for (const t of tables) {
                lines.push(`  ${t.name} (${t.type})`);
              }
              return { content: [{ type: "text" as const, text: lines.join("\n") }], details: null };
            }
          } catch (e: any) {
            return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: null };
          }
        },
      },
      { name: "db_schema" }
    );

    api.registerTool(
      {
        name: "db_connections",
        label: "Database Connections",
        description: "List all configured database connections and their status.",
        parameters: Type.Object({}),
        async execute() {
          const lines: string[] = ["Configured connections:\n"];
          for (const [name, connCfg] of Object.entries(cfg.connections)) {
            const isDefault = name === cfg.defaultConnection ? " (default)" : "";
            const readOnly = isReadOnly(connCfg.readOnly, cfg.allowMutations);
            const existing = drivers.get(name);
            let status = "not connected";
            if (existing) {
              const alive = await existing.ping().catch(() => false);
              status = alive ? "connected" : "disconnected";
            }
            lines.push(`  ${name}${isDefault}`);
            lines.push(`    driver: ${connCfg.driver}`);
            lines.push(`    target: ${maskConnectionString(connCfg)}`);
            lines.push(`    mode: ${readOnly ? "read-only" : "read-write"}`);
            lines.push(`    status: ${status}`);
          }
          if (Object.keys(cfg.connections).length === 0) {
            lines.push("  (none configured)");
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }], details: null };
        },
      },
      { name: "db_connections" }
    );

    // ── Slash Commands ────────────────────────────────────────────────

    api.registerCommand({
      name: "db",
      description: "Quick SQL query against default connection",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = ctx.args;
        if (!args?.trim()) {
          return { text: "Usage: /db SELECT * FROM users LIMIT 10" };
        }
        try {
          const connName = resolveConnectionName();
          const connCfg = cfg.connections[connName];
          const readOnly = isReadOnly(connCfg?.readOnly, cfg.allowMutations);
          const safety = validateQuery(args, !readOnly);
          if (!safety.allowed) return { text: safety.reason! };

          const driver = await getDriver(connName);
          const result = await driver.query(args, Math.min(100, cfg.maxRows), cfg.queryTimeout);
          return { text: formatResults(result.rows, "table", result.totalAvailable) };
        } catch (e: any) {
          return { text: `Error: ${e.message}` };
        }
      },
    });

    // ── CLI ────────────────────────────────────────────────────────────

    api.registerCli(
      ({ program }: any) => {
        const db = program.command("db").description("Database query commands");

        db
          .command("query")
          .description("Execute a SQL query")
          .argument("<sql>", "SQL query to execute")
          .option("-c, --connection <name>", "Connection name")
          .option("-f, --format <fmt>", "Output format: table, json, csv", "table")
          .option("-l, --limit <n>", "Max rows", "100")
          .action(async (sql: string, opts: any) => {
            try {
              const connName = resolveConnectionName(opts.connection);
              const connCfg = cfg.connections[connName];
              const readOnly = isReadOnly(connCfg?.readOnly, cfg.allowMutations);
              const safety = validateQuery(sql, !readOnly);
              if (!safety.allowed) { console.error(safety.reason); process.exit(1); }

              const driver = await getDriver(connName);
              const limit = Math.min(parseInt(opts.limit), cfg.maxRows);
              const result = await driver.query(sql, limit, cfg.queryTimeout);
              console.log(formatResults(result.rows, opts.format, result.totalAvailable));
            } catch (e: any) {
              console.error(`Error: ${e.message}`);
              process.exit(1);
            }
          });

        db
          .command("schema")
          .description("Inspect database schema")
          .option("-c, --connection <name>", "Connection name")
          .option("-t, --table <name>", "Table to describe")
          .action(async (opts: any) => {
            try {
              const connName = resolveConnectionName(opts.connection);
              const driver = await getDriver(connName);

              if (opts.table) {
                const columns = await driver.describeTable(opts.table);
                console.log(`\nTable: ${opts.table}\n`);
                for (const col of columns) {
                  const pk = col.primaryKey ? " [PK]" : "";
                  const nullable = col.nullable ? " nullable" : " NOT NULL";
                  const def = col.defaultValue ? ` default=${col.defaultValue}` : "";
                  console.log(`  ${col.name}: ${col.type}${nullable}${def}${pk}`);
                }
              } else {
                const tables = await driver.listTables();
                if (tables.length === 0) { console.log("No tables found."); return; }
                for (const t of tables) {
                  console.log(`  ${t.name} (${t.type})`);
                }
              }
            } catch (e: any) {
              console.error(`Error: ${e.message}`);
              process.exit(1);
            }
          });

        db
          .command("connections")
          .description("List configured database connections")
          .action(async () => {
            for (const [name, connCfg] of Object.entries(cfg.connections)) {
              const isDefault = name === cfg.defaultConnection ? " (default)" : "";
              const readOnly = isReadOnly(connCfg.readOnly, cfg.allowMutations);
              console.log(`${name}${isDefault} — ${connCfg.driver} — ${maskConnectionString(connCfg)} — ${readOnly ? "read-only" : "read-write"}`);
            }
            if (Object.keys(cfg.connections).length === 0) {
              console.log("No connections configured.");
            }
          });
      },
      { commands: ["db"] }
    );

    // ── Service ───────────────────────────────────────────────────────

    api.registerService({
      id: "db-query",
      start: async () => {
        api.logger.info("db-query: service started");
      },
      stop: async () => {
        for (const [name, driver] of drivers) {
          await driver.close().catch(() => {});
          api.logger.info(`db-query: closed connection "${name}"`);
        }
        drivers.clear();
        api.logger.info("db-query: stopped");
      },
    });
  },
};

export default plugin;
