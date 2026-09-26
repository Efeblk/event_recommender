# Windows setup

The current application runs directly on Windows with Node.js **22.13 or newer**. It does not require Make, WSL, Docker, Python, or the archived `frontend/` application.

From PowerShell in the repository root, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
cd .\web
npm.cmd run local:start
```

Open **http://127.0.0.1:3001**. The setup script checks Node.js, installs the locked dependencies in `web/` and `collector/`, and invokes the canonical `local:setup` task. That task creates the ignored `web/.dev.vars` file when needed and generates its `SYNC_TOKEN` without printing it. Re-running setup keeps existing values. An older `web/.env` is also left untouched, but new local secrets should go in `.dev.vars`.

The keyless preview supports deterministic filtering and keyword search. Full AI ranking needs both of these values in `web/.dev.vars`:

```dotenv
TYPESAFE_API_KEY=
VOYAGE_API_KEY=
```

Fill them in locally and restart `local:start`; do not paste secrets into chat or commit the file. The configured defaults already select `jev-1.13.0` and `voyage-4-large`, so model entries are unnecessary unless the application configuration changes. TypeSafe Jev evaluates the shortlist, while Voyage supplies semantic retrieval; either missing key causes the corresponding feature to fall back safely.

A Cloudflare API token is not needed for the local preview. Wrangler emulates D1 and R2 locally under `web/.wrangler/`. Cloudflare credentials are needed only for deployment and remote account operations.

To collect current event data and import the validated report into the running local D1 database, leave `local:start` running and use a second PowerShell terminal:

```powershell
cd .\web
npm.cmd run local:refresh -- --collect
```

This can take several minutes. The app rejects records last verified more than 72 hours ago, so refresh before relying on an old bundled snapshot. A successful local refresh is visible immediately and does not require a restart. To re-import an existing successful report, run `npm.cmd run local:refresh`; use `npm.cmd run local:refresh -- --report C:\path\to\report.json` for another report. Add `--index` only when `VOYAGE_API_KEY` is configured and you intend to spend Voyage quota indexing missing documents.

Restart `local:start` after code or provider-setting changes. For HMR development mode, use:

```powershell
npm.cmd run local:start -- --dev
```

Run the normal checks from `web/`:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd run test:smoke
```

PowerShell commands use `npm.cmd` explicitly to avoid script-execution policy issues that can affect `npm.ps1`.
