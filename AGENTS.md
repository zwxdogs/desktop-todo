## Agent skills

### Issue tracker

Issues live in the GitHub Issues of `zwxdogs/desktop-todo`, operated with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles; each label string equals its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Baseline

The Tauri 2 implementation (`app/`) is the baseline. The Tk 0.2.7 implementation (`todo.pyw`, its packaging chain and the root `build.ps1`) was deleted in 2026-11 — see `docs/adr/0006-remove-tk-fallback.md`; it survives only in git history and as the reference column of `app/PARITY.md`. Behaviour parity with 0.2.7 is **not** a constraint; record any intentional deviation in `app/PARITY.md` §3.

### Branching and release

`dev` is the integration branch: all features, fixes, and refactors land there first. `main` carries released code only.

- Work on `dev`. Do not commit directly to `main`; branch off `dev` only when a change needs isolation, then merge it back into `dev`.
- Release = run `powershell -NoProfile -ExecutionPolicy Bypass -File app\release.ps1` on a clean `dev`. It bumps `app/src-tauri/tauri.conf.json` (the only version source), syncs `Cargo.toml` and `Cargo.lock`, commits the bump (`chore: 发布 v<version>`), builds, deploys to `E:\桌面待办\DesktopTodo` (keeps `config.json`, deletes `_internal\`), restarts, merges `dev` into `main`, and tags `v<version>`; `-DryRun` rehearses, `-Push` publishes `main` and the tag.
- `dev` stays ahead of `main` between releases; never force-push `main`.

### Rebuild and redeploy after source changes

For a versioned release use `app\release.ps1` above. For a source-only rebuild-and-try cycle (no version bump), after ANY change to source code — adding a feature, fixing a bug, refactoring — always:

1. Rebuild with `powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1` (a bare `.\build.ps1` fails under the default execution policy). It runs `cargo build --release` and writes `dist\DesktopTodo\DesktopTodo.exe` + the release zip.
2. Update the local deployment at `E:\桌面待办\DesktopTodo`: stop the running `DesktopTodo.exe` process, replace `DesktopTodo.exe` from `dist\DesktopTodo\`, keep `config.json` untouched, and delete the legacy PyInstaller `_internal\` directory if it still exists.
3. Restart the app so the user can test the new build immediately.

Tests: `node --test app/ui/*.test.js tools/*.test.mjs` (195) and `cargo test` in `app/src-tauri`. `app\build.ps1` is the only build path — there is no Tk build script any more (ADR 0006).
