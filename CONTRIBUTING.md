# Contributing

Thanks for taking a look. This is a small, local-only plugin; the fastest way to
help is to try it on a page you actually care about and report what felt wrong.

## 本地开发 / Local development

```bash
# syntax checks (the same ones CI runs)
for f in lib/*.js scripts/*.mjs test/*.mjs; do node --check "$f"; done

# host half without starting DSH
node test/host-harness.mjs detect "D:/path/to/your/workspace"
node test/host-harness.mjs preview http://127.0.0.1:5173/ "D:/path/to/your/workspace"
```

- `lib/index.js` — host half. Changes here need a **full DSH restart**.
- `lib/client.js` — client half. Needs a page reload; if the bundle is cached by
  the host, restart DSH once so it is re-snapshotted.
- `lib/overlay.js`, `lib/shim.js` — injected into the previewed page and re-read
  on every HTML response, so a preview refresh is enough.

## 代码约定 / Conventions

- No build step and no runtime dependencies: plain ES modules on the host side,
  one hand-written `__ModuleLoader__` bundle on the client side.
- Comments explain *why* a decision exists, not what the next line does.
- Chinese UI copy is the default; keep strings in one place per file.
- The overlay must leave the page clean: everything it writes (DOM, listeners,
  inline styles, `history` patches) has to be undone when annotation mode ends.

## 提交 / Pull requests

- One focused change per commit; say what you observed and what you changed.
- If the change is about a gesture or a payload field, include the before/after
  annotation text you saw — that is the artifact this plugin exists to produce.
