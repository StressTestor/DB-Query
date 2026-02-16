const MUTATION_PATTERNS = [
  /^\s*INSERT\b/i,
  /^\s*UPDATE\b/i,
  /^\s*DELETE\b/i,
  /^\s*DROP\b/i,
  /^\s*ALTER\b/i,
  /^\s*TRUNCATE\b/i,
  /^\s*CREATE\b/i,
  /^\s*REPLACE\b/i,
  /^\s*MERGE\b/i,
  /^\s*GRANT\b/i,
  /^\s*REVOKE\b/i,
];

export interface SafetyResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if a query is safe to run given the mutation policy.
 * This is NOT about SQL injection — the agent IS the user here.
 * This prevents accidental destructive operations.
 */
export function validateQuery(query: string, allowMutations: boolean): SafetyResult {
  if (allowMutations) return { allowed: true };

  const trimmed = query.trim();

  for (const pattern of MUTATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      const verb = trimmed.split(/\s+/)[0].toUpperCase();
      return {
        allowed: false,
        reason: `${verb} blocked — mutations are disabled for this connection. Set allowMutations: true in config or per-connection readOnly: false to allow writes.`,
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
