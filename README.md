# codex-math-render

KaTeX-based math rendering injection for the Codex desktop app.

This repository packages the validated Proof of Concept we built for Codex desktop on macOS:

- inject a same-origin module into `Codex.app/Contents/Resources/app.asar`
- render inline `$...$` math and display `$$...$$` math in the chat webview
- update `ElectronAsarIntegrity`
- ad-hoc re-sign the modified app bundle so Codex can launch again

## Status

Current scope is intentionally conservative:

- Supports inline `$...$`
- Supports display `$$...$$`
- Skips `code`, `pre`, links, inputs, textareas, and editable editor roots
- Avoids rendering escaped dollars such as `\$x\$`
- Avoids rendering plain currency like `$5`
- Handles long streamed messages more conservatively by waiting for a short DOM settle window
- Restores `_..._` that Markdown may incorrectly convert to emphasis inside math

This is still a DOM injection PoC, not an official Codex plugin API.

## Tested Environment

Validated on:

- macOS
- Codex desktop app bundle installed at `/Applications/Codex.app`
- Electron app with `ElectronAsarIntegrity` enabled

If Codex changes its internal webview structure, selectors, CSP, or packaging, this PoC may need updates.

## Repository Layout

```text
.
├── install.sh
├── LICENSE
├── README.md
├── package.json
├── package-lock.json
├── scripts/
│   ├── install_codex_math_poc.mjs
│   └── uninstall_codex_math_poc.mjs
└── src/
    └── codex_math_poc.js
├── uninstall.sh
```

## Prerequisites

1. Node.js 20+ recommended
2. npm available locally
3. Codex desktop installed
4. macOS command line tools available for:
   - `plutil`
   - `codesign`

## Install Dependencies

```bash
npm install
```

You can also skip this manual step and let `install.sh` do it automatically on first run.

## What The Installer Does

`scripts/install_codex_math_poc.mjs` performs the following steps:

1. Open the target `Codex.app`
2. Back up the app bundle to a temp directory unless an explicit backup path is provided
3. Extract `Contents/Resources/app.asar`
4. Inject a same-origin module tag into `webview/index.html`
5. Copy `src/codex_math_poc.js` into `webview/assets/codex-math-poc.js`
6. Repack `app.asar`
7. Recompute `ElectronAsarIntegrity` in `Info.plist`
8. Re-sign the modified `.app` bundle using ad-hoc signing unless `--no-resign` is passed

## Install Into Codex

Recommended:

```bash
bash ./install.sh
```

Optional custom app path:

```bash
bash ./install.sh /Applications/Codex.app
```

Direct Node entry:

```bash
node ./scripts/install_codex_math_poc.mjs --app /Applications/Codex.app
```

Optional flags:

- `--backup-dir /path/to/Codex-backup.app`
- `--no-resign`

A successful run prints JSON like this:

```json
{
  "ok": true,
  "appPath": "/Applications/Codex.app",
  "backupDir": "/var/folders/.../Codex-backup-....app",
  "injected": false,
  "headerHash": "...",
  "resigned": true
}
```

`injected: false` is normal on repeated installs. It means the HTML already contains the module tag and the installer updated the renderer asset in place.

The installer also writes a local state file:

```text
.codex-math-render-state.json
```

This records the last installed app path and backup path so uninstall can restore automatically.

## Verification Checklist

After installation:

1. Fully quit Codex desktop
2. Re-open Codex
3. Verify inline math renders:

```text
Euler: $e^{i\pi}+1=0$
```

4. Verify display math renders:

```text
$$
\frac{d}{dx}\sin(x)=\cos x
$$
```

5. Verify these stay literal:

```text
I paid $5 for lunch.
```

```text
`code $x$`
```

```text
\$x\$
```

## Known Limitations

- This project patches the installed Codex desktop app directly
- It relies on Codex's current DOM and package structure
- It is intentionally conservative and may miss some malformed or heavily transformed inline math
- It does not yet implement a full Markdown-aware LaTeX parser
- It assumes the last generated backup is still available when using automatic uninstall

## Rollback

The installer creates a backup app bundle and records its path in `.codex-math-render-state.json`.

Recommended automatic rollback:

```bash
bash ./uninstall.sh
```

If you want to override the backup path explicitly:

```bash
node ./scripts/uninstall_codex_math_poc.mjs --app /Applications/Codex.app --backup /path/to/Codex-backup.app
```

Typical flow:

1. Quit Codex
2. Run `bash ./uninstall.sh`
3. The backup app bundle is copied back over the patched app
4. The restored app is verified with `codesign --verify --deep --strict`
5. Launch Codex again

## Development Notes

Key implementation choices in `src/codex_math_poc.js`:

- per-text-node inline rendering for the common case
- conservative flatten fallback for split text/span containers
- currency-vs-math disambiguation for `$5 ... $x^2$`
- underscore restoration when Markdown emphasis breaks math
- deferred processing to reduce conflicts with streaming message updates
- ancestor requeueing so long streamed paragraphs get rescanned at the correct container level

## Safety Notes

This project modifies an installed desktop application bundle. Use it only if you are comfortable patching a local Electron app and re-signing it.

If you want stronger safety before experimenting:

- work on a copied app bundle first
- keep the generated backup
- verify with `codesign --verify --deep --strict /Applications/Codex.app`

## License

See [LICENSE](./LICENSE).
