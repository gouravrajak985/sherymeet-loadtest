type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

/** Structured JSON-lines logging; warnings and errors go to stderr. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(line + "\n");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
