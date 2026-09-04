# Onyx — design notes & backlog

## Settled architecture

- **One dedicated, permanently-registered vault** (`~/OE`), registered in
  `obsidian.json` once, by hand, like any normal vault. Never touched
  programmatically.
- **Default way to edit a project:** the project's real directory lives *inside*
  the vault tree (`~/OE/some-project/…`). No symlinks, no CLI. Obsidian's native
  file explorer, Quick Switcher, and full-text search all work because the files
  are genuinely vault-resident.
- **Secondary (out-of-tree repos):** symlink the repo into the vault
  (`~/OE/XYZ-<hash>` → `~/XYZ`). The symlink is the only artifact; nothing is
  written into the target repo. Second-class: needs the URI-translation shim
  below, and only TS/Python behave well behind it.
- **Editor component:** hand-rolled on CodeMirror 6 (Obsidian's native editor),
  not Monaco. `@codemirror/lang-*` for highlighting (pure JS, no WASM/native).
- **Distribution:** aiming for the community store eventually, so design within
  the review guidelines from the start (`isDesktopOnly`, explicit user action for
  any filesystem side effect, `child_process` only from user-configured commands,
  full cleanup in `onunload`, disclosure in README).

## Dependency constraint (already hit)

Obsidian 1.13.x hard-pins `@codemirror/state@6.5.0` / `@codemirror/view@6.38.6` as
peer deps. `codemirror-languageserver@>=1.20` requires `@codemirror/state@^6.5.2`
as a **peer** → `npm install` hard-fails. Resolution: use
**`@codemirror/lsp-client`** (official CM package) instead — it declares its CM6
needs as regular `dependencies`, so npm nests them without conflict, and at bundle
time they're externalized to Obsidian's copy anyway. Do **not** reintroduce
`codemirror-languageserver`.

---

## Backlog — deferred, implement later

### 1. LSP integration
- `@codemirror/lsp-client` + a custom stdio `Transport` backed by `vscode-jsonrpc`
  over `child_process`.
- **Dev-shell-aware spawning:** language servers live inside the target repo's Nix
  dev shell / direnv, not on Obsidian's PATH. Spawn through the shell entry point:
  `nix develop <repo> -c <server>` or `direnv exec <repo> <server>`, cwd = repo.
- Launch prefix is **per-project**, configurable (folder path → prefix). Auto-detect
  as a convenience: `flake.nix` → `nix develop -c`; `.envrc` → `direnv exec .`.
  Manual config is the reliable fallback.

### 2. Per-`(projectRoot × languageId)` server registry
- One `LSPClient` per key `${realRootPath}\0${languageId}`, **not** per vault.
- On open: resolve the file's real path, walk up to the nearest project root
  (marker: `.git` / `Cargo.toml` / `flake.nix` / `pyproject.toml`, or an
  explicitly-registered root). Direct children of the vault's `workspace/` dir are
  roots by default; marker-walk is the monorepo fallback; explicit override list
  on top.
- Refcount attached editors; shut a server down on last-close or idle timeout.
- `onunload` kills the entire registry.

### 3. Symlink manager (out-of-tree repos)
- Create: resolve `<path>` to canonical absolute (`realpath`); dedup-scan
  `workspace/` for an existing link with the same target (`readlink`); if none,
  create `<basename>-<short-hash-of-realpath>` → target.
- Remove: explicit "close" unlinks immediately.
- Stale-sweep on plugin load: remove links this plugin created whose target no
  longer exists (tag our links, e.g. a manifest file in `workspace/`).
- Optional thin CLI (`obsidian-editor <path>` / `--close`) as a terminal
  front-end to the same plugin-side logic. Cannot ship through the community
  store (store distributes only `main.js`/`manifest.json`/`styles.css`) —
  separate install.
- Windows: real symlinks need Developer Mode / admin; junctions differ. Untested.

### 4. URI translation shim (symlink case only)
- Spawn the server rooted at the **real** target path (`~/XYZ`), never the
  vault-side symlink path — the server then never sees a symlink and won't
  canonicalize inconsistently.
- Wrap the `Transport`: rewrite every `uri` field `~/OE/XYZ-<hash>/…` ↔ `~/XYZ/…`
  in both directions. Deterministic prefix swap; we know both ends.
- Go stays broken behind a symlink even with the shim; Rust is shaky. TS/Python OK.

### 5. External-file read-only view (needed for BOTH default and symlink paths)
- Go-to-definition into stdlib / dependencies (`~/.cargo/registry/…`,
  `/nix/store/…`) lands outside the vault → no `TFile`, native view can't open it.
- A `CodeView` variant backed by raw `fs` (read-only) that takes an absolute path
  as state instead of a `TFile`.

### 6. Vault indexing hygiene
- Seed `userIgnoreFilters` (excluded-files globs) so a symlinked/real project tree
  doesn't drown the index: `node_modules`, `.git`, `target`, `dist`, `build`,
  `.direnv`, `.venv`, `__pycache__`.
- Offer to seed on first run.

### 7. Vault realpath at startup
- If the vault root itself is under a symlink, servers canonicalize and every
  project hits the URI mismatch. Resolve `fs.realpathSync(vault.adapter.basePath)`
  once and use it as the URI base so editor and server always agree.

### 8. Baked-in Tier-1 language servers
- Pure-JS servers that run on Electron's own Node and don't care about project
  PATH: `vscode-langservers-extracted` (HTML/CSS/JSON/ESLint), `pyright`,
  `typescript-language-server`, `bash-language-server`.
- Run in a Web Worker with an in-memory transport — no `child_process`, better for
  store review; must be esbuilt into `main.js`.
- Ship one (`vscode-langservers-extracted`) first to prove the path.

### 9. Lazy language loading
- Swap the static `@codemirror/lang-*` imports for `@codemirror/language-data` +
  dynamic import once the bundle grows uncomfortable.

### 10. Multi-view editing — follow-ups
Live sync between open views of the same file is implemented (ChangeSet replay
between peer `CodeView`s, guarded by a `mirroredEdit` annotation). The
correctness pass (`HANDOFF.md`) landed most of this section:

- **External-modification conflict.** DONE — C4. `ExternalChangeModal`
  reload-vs-keep prompt, autosave suspended while it's open.
- **Save policy + dirty window.** DONE — C5. `DocumentSession` owns a
  configurable `afterDelay` debounce; `onFocusChange`; `manual`. Shared dirty
  flag was already session-level; cleared on confirmed `save()`.
- **Multi-view LSP.** DONE — C2. Every pane carries `client.plugin(...)`.
- **Selection/scroll** stay per-view (correct, matches VS Code). No work needed.

Still to do:
- **Shared undo history.** Each view has its own `history()`; mirrored edits are
  now dispatched `addToHistory: false` (C6) so undo is at least per-pane and
  never cross-contaminates. A true single shared stack (undo in A reverses an
  edit made in B) still needs a custom history or the `collab` approach.
- **Native "unsaved" tab dot.** Driven by a private Obsidian field on the view;
  not wired for store-review reasons. Dirty shows in the status bar only. If a
  supported API appears, hook it in `CodeView`.
- **`updateFile` (server rename/format edits)** fan out to panes but don't
  recompute session dirty state — wire that when rename/format actually land.

### 11. Settings tab — declarative API
`OnyxSettingTab` uses the imperative `display()` form. `eslint-plugin-obsidianmd`
warns that on Obsidian 1.13+ settings should implement `getSettingDefinitions()`
(declarative) so they show up in Obsidian's settings search. Adopt before store
submission.

### 12. Visual polish — status & follow-ups
Curated `--onyx-*` token layer in `styles.css` (mapped onto Obsidian colour
primitives), `editorStyle()` in `theme.ts` (chrome + curated `HighlightStyle` +
indent guides), appearance settings, `@codemirror/search` panel + selection-match
highlighting. Done. Remaining:
- **`@codemirror/search` is externalized** (assumed provided by Obsidian, like the
  sample plugin). If it fails to load, un-external it in `esbuild.config.mjs` and
  add to `dependencies`.
- **Palette tuning** — the tag→primitive assignment (`--onyx-syntax-*`) is a first
  pass; eyeball it against a few themes and adjust. Property = `--color-red` and
  type = `--color-yellow` are the least certain choices.
- **Bundled schemes** — a follow-up could add named schemes (One Dark/Light, Ayu)
  as additional `colorScheme` options beyond "onyx" / "obsidian".
- **Whitespace rendering** and **column rulers** were scoped out of this pass;
  add as toggles later.
- **Cursor-position status bar** (`Ln, Col · N selected`) not yet done.
- **Syntax-highlight hover / signature-help code.** DONE.
  - Fenced blocks: lsp-client already highlights them (`highlightCode` +
    `highlightingFor(view.state, …)`), it just needed `highlightLanguage` in the
    `LSPClient` config — `languageByName` in `languages.ts`.
  - Inline `code` (clangd's "Parameters:" bullet list, `→ Value`, `std::x` in
    prose): markdown associates no language with it, so lsp-client leaves it
    plain. `lsp/hover-highlight.ts` (`highlightDocCodeInto`) post-processes the
    sanitised doc DOM in `main.ts`'s sanitise closure — re-highlights every
    inline `code` (and any un-tokenised `<pre>`) as the hovered file's language
    using the *same* `HighlightStyle` the editor uses (`docHighlightStyle` in
    `theme.ts`), so inline code matches the fenced blocks and the editor.
  - Registry `sanitizeDoc` callback now takes `(html, languageId)`; `buildClient`
    binds the language per client.
  - The signature *label* is drawn as plain text by lsp-client (not hookable);
    its active parameter gets `.cm-lsp-active-parameter`, styled in `theme.ts`.
    Full-label highlight would need overriding `drawSignatureTooltip` — skipped.

### 13. Misc
- Confirm `obsidian://open?path=…` pointed at a path inside an already-registered
  vault resolves correctly (expected per docs, untested).
- Confirm Obsidian's watcher picks up a symlinked dir added post-launch without a
  manual rescan.
