const MAX_CELL_WIDTH = 200;

export type OutputFormat = "table" | "json" | "csv";

interface Column {
  name: string;
  width: number;
}

function sanitizeCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Buffer || value instanceof Uint8Array) {
    return `[BLOB ${value.length} bytes]`;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[Object]";
    }
  }
  const str = String(value);
  if (str.length > MAX_CELL_WIDTH) return str.slice(0, MAX_CELL_WIDTH - 3) + "...";
  return str;
}

export function formatResults(
  rows: Record<string, unknown>[],
  format: OutputFormat,
  totalAvailable?: number,
): string {
  if (rows.length === 0) return "No results.";

  switch (format) {
    case "json":
      return JSON.stringify(rows.map(row => sanitizeRow(row)), null, 2);
    case "csv":
      return formatCsv(rows);
    case "table":
    default:
      return formatTable(rows, totalAvailable);
  }
}

function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Buffer || v instanceof Uint8Array) {
      clean[k] = `[BLOB ${v.length} bytes]`;
    } else if (v === null || v === undefined) {
      clean[k] = null;
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

function formatCsv(rows: Record<string, unknown>[]): string {
  const columns = Object.keys(rows[0]);
  const lines: string[] = [columns.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(columns.map(c => csvEscape(sanitizeCell(row[c]))).join(","));
  }
  return lines.join("\n");
}

function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function formatTable(rows: Record<string, unknown>[], totalAvailable?: number): string {
  const columns: Column[] = Object.keys(rows[0]).map(name => ({
    name,
    width: name.length,
  }));

  const cellGrid: string[][] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      const cell = sanitizeCell(row[columns[i].name]);
      columns[i].width = Math.min(Math.max(columns[i].width, cell.length), MAX_CELL_WIDTH);
      cells.push(cell);
    }
    cellGrid.push(cells);
  }

  const header = columns.map(c => c.name.padEnd(c.width)).join(" | ");
  const sep = columns.map(c => "─".repeat(c.width)).join("─┼─");
  const body = cellGrid.map(cells =>
    cells.map((cell, i) => cell.padEnd(columns[i].width)).join(" | ")
  );

  const lines = [header, sep, ...body];

  if (totalAvailable !== undefined && totalAvailable > rows.length) {
    lines.push(`\n(showing ${rows.length} of ${totalAvailable} rows)`);
  } else {
    lines.push(`\n(${rows.length} row${rows.length === 1 ? "" : "s"})`);
  }

  return lines.join("\n");
}
