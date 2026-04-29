# NanoClaw Desktop

Tauri 2 wrapper around the local browser chat. Bundles the SPA into a native `.app` / `.exe` / `.AppImage` so a non-technical user gets a real desktop icon instead of a browser tab.

This is **only a shell** — the agent + UI still run in the host Node service at `http://127.0.0.1:3030`. The bundled binary opens a window, polls the host, and redirects to the loopback URL once it responds. If the host is stopped, the window shows a "Connecting to NanoClaw…" spinner with auto-retry.

## When to use this

Skip this entirely if your user is fine opening `http://127.0.0.1:3030` in a browser tab — that's already the right answer for most setups. Bundle this only when you want:

- A real Dock / Start menu icon
- A separate window without browser chrome
- Code-signing for distribution to other people on the same machine class

## Prerequisites

The host service does **not** need any of these — they're only required to *build* the desktop binary.

- **Rust toolchain**: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Node 20+** (already installed for the host)
- **Platform build deps:**
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `webkit2gtk-4.1` + `libssl-dev` + `librsvg2-dev` + `libayatana-appindicator3-dev`
  - Windows: Visual Studio Build Tools 2022 + WebView2 runtime

Full per-platform list: <https://tauri.app/start/prerequisites/>.

## Develop

```bash
cd desktop
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` opens a window pointing at the bootstrap page in `static/index.html`. The bootstrap polls `http://127.0.0.1:3030/api/info` every two seconds (no-cors, so the host doesn't need CORS headers) and redirects the window once the host is reachable.

The host service must already be running — `desktop/` is a separate package and does not start the Node host.

## Build

```bash
cd desktop
pnpm tauri build
```

Bundles land in `desktop/src-tauri/target/release/bundle/`:

| Platform | Output |
|----------|--------|
| macOS    | `macos/NanoClaw.app`, `dmg/NanoClaw_<version>_<arch>.dmg` |
| Linux    | `deb/`, `rpm/`, `appimage/` |
| Windows  | `msi/`, `nsis/` |

First build takes 5–15 minutes (Rust crate graph). Incremental rebuilds are fast.

## Icons

Placeholder PNGs ship in `src-tauri/icons/` so the build doesn't fail on a fresh checkout. Before distributing, replace them with a real icon set:

```bash
cd desktop
pnpm tauri icon path/to/source-1024.png
```

This regenerates `32x32.png`, `128x128.png`, `128x128@2x.png`, plus the platform-specific `icon.icns` (macOS) and `icon.ico` (Windows). After running, add those two filenames to `bundle.icon` in `tauri.conf.json` so they're included.

## Customizing the host URL

If the host runs on a non-default port (you set `LOCAL_HTTP_PORT` somewhere), edit the `HOST` constant near the top of the `<script>` block in `static/index.html`:

```javascript
const HOST = 'http://127.0.0.1:3030';
```

The Tauri window title, dimensions, and identifier all live in `src-tauri/tauri.conf.json`.

## Layout

```
desktop/
├── package.json              # tauri CLI dep
├── README.md                 # this file
├── static/
│   └── index.html            # bootstrap (polls + redirects)
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json       # window + bundle config
│   ├── build.rs
│   ├── src/main.rs           # webview shell, no IPC
│   ├── icons/*.png           # placeholder icons
│   └── capabilities/default.json
```

`src-tauri/target/` (Rust build output) and `src-tauri/gen/` (Tauri-generated schema files) are gitignored.
