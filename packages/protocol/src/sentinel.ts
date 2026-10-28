/**
 * Completion sentinel for shell commands.
 *
 * After typing the user command, BastionPilot appends
 *   echo __BP_<nonce>_$?__
 * The literal `$?` in the echoed input never matches the result regex
 * (which requires digits), so only the *executed* sentinel line can resolve
 * the wait, and it also carries the command's exit code.
 */

const NONCE_RE = /^[0-9a-f]{8}$/;

export function newSentinelNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidNonce(nonce: string): boolean {
  return NONCE_RE.test(nonce);
}

/** The shell command appended after the user command. */
export function sentinelCommandFor(nonce: string): string {
  if (!isValidNonce(nonce)) throw new Error(`invalid sentinel nonce: ${nonce}`);
  return `echo __BP_${nonce}_$?__`;
}

/**
 * Full payload to type into the terminal for a command execution:
 * the command, then the sentinel echo, each on its own line.
 */
export function wrapCommandWithSentinel(command: string, nonce: string): string {
  const cmd = command.replace(/\n+$/, '');
  return `${cmd}\n${sentinelCommandFor(nonce)}\n`;
}

export function sentinelRegexFor(nonce: string): RegExp {
  if (!isValidNonce(nonce)) throw new Error(`invalid sentinel nonce: ${nonce}`);
  return new RegExp(`__BP_${nonce}_(\\d+)__`);
}

/** Extract the exit code from terminal output for the given nonce, if present. */
export function extractExitCode(text: string, nonce: string): number | null {
  const m = sentinelRegexFor(nonce).exec(text);
  if (!m) return null;
  const code = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(code) ? code : null;
}
