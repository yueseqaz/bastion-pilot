import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PROFILES,
  normalizeOrigin,
  originToMatchPattern,
  profileById,
  urlMatchesSite,
} from '../src/profiles.js';

describe('profiles', () => {
  it('normalizes user-supplied origins', () => {
    expect(normalizeOrigin('bastion.example.com')).toBe('https://bastion.example.com');
    expect(normalizeOrigin('http://10.0.0.1:8080/')).toBe('http://10.0.0.1:8080');
    expect(normalizeOrigin('https://BASTION.Example.COM/path')).toBe('https://bastion.example.com');
    expect(normalizeOrigin('ftp://bad.example.com')).toBeNull();
    expect(normalizeOrigin('not a url')).toBeNull();
  });

  it('builds match patterns from origins', () => {
    expect(originToMatchPattern('https://bastion.example.com')).toBe(
      'https://bastion.example.com/*'
    );
    expect(originToMatchPattern('nonsense')).toBeNull();
  });

  it('matches URLs against site origins', () => {
    expect(
      urlMatchesSite('https://bastion.example.com/koko/ssh/1', 'https://bastion.example.com')
    ).toBe(true);
    expect(urlMatchesSite('https://evil.example.com/', 'https://bastion.example.com')).toBe(false);
  });

  it('falls back to the generic profile', () => {
    expect(profileById('jumpserver').id).toBe('jumpserver');
    expect(profileById(undefined).id).toBe('generic-xterm');
    expect(profileById('does-not-exist').id).toBe('generic-xterm');
  });

  it('ships the built-in profiles with raw framing defaults', () => {
    for (const profile of BUILTIN_PROFILES) {
      expect(profile.framer.type).toBe('raw');
      expect(profile.inputMode).toBe('socket');
    }
  });
});
