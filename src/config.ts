export interface ConnectionConfig {
  driver: "sqlite" | "postgres" | "mysql";
  path?: string;
  connectionString?: string;
  readOnly?: boolean;
}

export interface DbQueryConfig {
  connections: Record<string, ConnectionConfig>;
  defaultConnection: string;
  maxRows: number;
  queryTimeout: number;
  allowMutations: boolean;
}

const DEFAULTS: DbQueryConfig = {
  connections: {},
  defaultConnection: "",
  maxRows: 1000,
  queryTimeout: 30000,
  allowMutations: false,
};

export function resolveConfig(raw?: Record<string, unknown>): DbQueryConfig {
  if (!raw) return { ...DEFAULTS };
  return {
    connections: (raw.connections as Record<string, ConnectionConfig>) ?? {},
    defaultConnection: (raw.defaultConnection as string) ?? Object.keys((raw.connections as object) ?? {})[0] ?? "",
    maxRows: Math.min((raw.maxRows as number) ?? 1000, 10000),
    queryTimeout: (raw.queryTimeout as number) ?? 30000,
    allowMutations: (raw.allowMutations as boolean) ?? false,
  };
}

/**
 * Expand $ENV_VAR references in a string to their process.env values.
 * Throws if the variable is not set.
 */
export function expandEnv(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_match, name) => {
    const val = process.env[name];
    if (val === undefined) {
      throw new Error(`Environment variable $${name} is not set. Set it before connecting.`);
    }
    return val;
  });
}

/**
 * Resolve a path, expanding ~ to home directory and $ENV_VAR references.
 */
export function resolvePath(p: string): string {
  let resolved = expandEnv(p);
  if (resolved.startsWith("~/")) {
    resolved = resolved.replace("~", process.env.HOME ?? "/tmp");
  }
  return resolved;
}
