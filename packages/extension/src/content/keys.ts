/** Special-key sequences as a real keyboard would emit them (raw PTY bytes). */
export const KEY_SEQUENCES: Record<string, string> = {
  enter: '\r',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+z': '\x1a',
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  'ctrl+l': '\x0c',
  'ctrl+u': '\x15',
  'ctrl+a': '\x01',
  'ctrl+e': '\x05',
  'ctrl+k': '\x0b',
  'ctrl+w': '\x17',
};

export function keySequence(key: string): string | null {
  return KEY_SEQUENCES[key] ?? null;
}

/**
 * Fallback input mode for products that intercept keystrokes client-side:
 * synthesize keyboard events into the xterm helper textarea.
 */
export function domTypeText(text: string): boolean {
  const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
  if (!textarea) return false;
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        })
      );
      continue;
    }
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true })
    );
    textarea.dispatchEvent(
      new KeyboardEvent('keypress', { key: ch, bubbles: true, cancelable: true })
    );
  }
  return true;
}
