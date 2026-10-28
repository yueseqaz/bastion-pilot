import { describe, expect, it } from 'vitest';
import {
  extractExitCode,
  isValidNonce,
  newSentinelNonce,
  sentinelCommandFor,
  sentinelRegexFor,
  wrapCommandWithSentinel,
} from '../src/sentinel.js';

describe('sentinel', () => {
  it('generates valid 8-hex nonces', () => {
    for (let i = 0; i < 20; i++) {
      const n = newSentinelNonce();
      expect(isValidNonce(n)).toBe(true);
    }
  });

  it('wraps a command with trailing-newline normalization', () => {
    expect(wrapCommandWithSentinel('ls -la\n\n\n', 'ab12cd34')).toBe(
      'ls -la\necho __BP_ab12cd34_$?__\n',
    );
  });

  it('builds the echo command with literal $?', () => {
    expect(sentinelCommandFor('ab12cd34')).toBe('echo __BP_ab12cd34_$?__');
  });

  it('extracts exit code 0 from output', () => {
    const out = [
      'file1  file2',
      'echo __BP_ab12cd34_$?__', // echoed input line — must NOT match
      '__BP_ab12cd34_0__',
      'prompt$ ',
    ].join('\n');
    expect(extractExitCode(out, 'ab12cd34')).toBe(0);
  });

  it('extracts non-zero exit codes', () => {
    const out = 'something\n__BP_ab12cd34_127__\n';
    expect(extractExitCode(out, 'ab12cd34')).toBe(127);
  });

  it('does not match the echoed command containing literal $?', () => {
    expect(extractExitCode('echo __BP_ab12cd34_$?__\n', 'ab12cd34')).toBeNull();
  });

  it('returns null when the sentinel has not appeared yet', () => {
    expect(extractExitCode('partial output still running', 'ab12cd34')).toBeNull();
  });

  it('rejects invalid nonces', () => {
    expect(isValidNonce('zz')).toBe(false);
    expect(() => sentinelCommandFor('NOT-VALID')).toThrow();
    expect(() => sentinelRegexFor('gogogo')).toThrow();
  });
});
