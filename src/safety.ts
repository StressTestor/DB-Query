const MUTATION_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "DROP", "ALTER",
  "TRUNCATE", "CREATE", "REPLACE", "MERGE", "GRANT", "REVOKE",
];

export interface SafetyResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Strip string literals and comments from SQL so keyword detection
 * doesn't false-positive on values like 'DROP me a line'.
 */
function stripLiteralsAndComments(sql: string): string {
  return sql
    // Remove single-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "")
    // Remove double-quoted identifiers
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    // Remove block comments
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Remove line comments
    .replace(/--[^\n]*/g, "");
}

/**
 * Check if a query is safe to run given the mutation policy.
 * This is NOT about SQL injection — the agent IS the user here.
 * This prevents accidental destructive operations.
 *
 * Scans the entire query body (not just the first token) to catch
 * CTE bypass (WITH x AS (DELETE ...)) and multi-statement bypass (; DROP ...).
 */
export function validateQuery(query: string, allowMutations: boolean): SafetyResult {
  if (allowMutations) return { allowed: true };

  const trimmed = query.trim();

  // Block multiple statements: strip trailing semicolon, then reject if any remain
  const stripped = trimmed.replace(/;\s*$/, "");
  if (stripped.includes(";")) {
    return { allowed: false, reason: "multiple statements not allowed" };
  }

  // Strip literals and comments so keywords inside strings don't trigger blocks
  const sanitized = stripLiteralsAndComments(trimmed);

  for (const keyword of MUTATION_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`, "i");
    if (re.test(sanitized)) {
      return {
        allowed: false,
        reason: `${keyword} blocked — mutations are disabled for this connection. Set allowMutations: true in config or per-connection readOnly: false to allow writes.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Check if a connection is effectively read-only.
 * Per-connection readOnly overrides global allowMutations.
 */
export function isReadOnly(connectionReadOnly: boolean | undefined, globalAllowMutations: boolean): boolean {
  if (connectionReadOnly !== undefined) return connectionReadOnly;
  return !globalAllowMutations;
}
