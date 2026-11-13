## Agent skills

### Issue tracker

Issues live in the GitHub Issues of `zwxdogs/desktop-todo`, operated with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles; each label string equals its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Branching and release

`dev` is the integration branch: all features, fixes, and refactors land there first. `main` carries released code only.

- Work on `dev`. Do not commit directly to `main`; branch off `dev` only when a change needs isolation, then merge it back into `dev`.
- Release = merge `dev` into `main`, bump the version in `app/src-tauri/tauri.conf.json` (+ `Cargo.toml`), commit, tag `v<version>`, push `main` and the tag, then rebuild and redeploy per below.
- `dev` stays ahead of `main` between releases; never force-push `main`.

### Rebuild and redeploy after source changes

After ANY change to source code — adding a feature, fixing a bug, refactoring, bumping the version — always:

1. Rebuild with `powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1` (a bare `.\build.ps1` fails under the default execution policy). It runs `cargo build --release` and writes `dist\DesktopTodo\DesktopTodo.exe` + the release zip.
2. Update the local deployment at `E:\桌面待办\DesktopTodo`: stop the running `DesktopTodo.exe` process, replace `DesktopTodo.exe` from `dist\DesktopTodo\`, keep `config.json` untouched, and delete the legacy PyInstaller `_internal\` directory if it still exists.
3. Restart the app so the user can test the new build immediately.

Tests: `node --test app/ui/*.test.js` (83). The root `build.ps1` belongs to the frozen Tk 0.2.7 fallback; do not use it for the Tauri app.
