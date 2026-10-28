# Site profiles

A profile describes everything product-specific about a bastion web terminal. Everything else
(WebSocket interception, buffering, sentinels, approvals) is shared.

## Anatomy

```jsonc
{
  "id": "my-bastion",
  "name": "My Bastion",
  "framer": {
    // how the PTY stream is framed
    "type": "raw", // raw | json | base64
    "dataField": "data", // json: field carrying the payload
    "encoding": "plain", // json: plain | base64
    "inputField": "input", // json: field for upstream input
  },
  "inputMode": "socket", // socket (raw PTY writes) | dom (keyboard events)
  "terminalDomHints": [".xterm"], // DOM markers identifying the terminal
  "promptHints": ["$ ", "# "],
}
```

Built-in profiles live in `packages/extension/src/profiles.ts`:

- `generic-xterm` — any xterm.js web terminal with a raw PTY stream (ttyd, koko, sshwifty, most
  bastion products).
- `jumpserver` — JumpServer's koko terminal (raw framing, JumpServer DOM hints).

## Adding support for a new product

1. Open the terminal in your browser, then DevTools → Network → WS → Messages. Watch the
   terminal's WebSocket frames:
   - Binary frames with raw PTY bytes → `raw` (works out of the box).
   - Text frames containing JSON → note the field that carries the payload and whether it is
     base64 → use `framer.type = "json"`.
   - Text frames containing base64 → `framer.type = "base64"`.
2. Add a new `SiteProfile` entry in `packages/extension/src/profiles.ts` (keep it declarative),
   including DOM hints unique to the product.
3. Select the profile for your origin in the extension options page.
4. Add a test in `packages/extension/test/` covering the framing (mirror `framer.test.ts`).

If the product intercepts keystrokes client-side (custom key handling), set `inputMode: "dom"`
so input is synthesized as keyboard events into the xterm textarea.
