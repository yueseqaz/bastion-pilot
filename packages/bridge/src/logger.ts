/** Minimal stderr logger. Never write to stdout: the MCP stdio transport owns it. */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  const line = (level: string, args: unknown[]) =>
    console.error(`[${new Date().toISOString()}] [${level}] [${scope}]`, ...args);
  return {
    info: (...args) => line('info', args),
    warn: (...args) => line('warn', args),
    error: (...args) => line('error', args),
  };
}
