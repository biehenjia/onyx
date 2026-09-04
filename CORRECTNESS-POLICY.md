# Correctness pass — working policy

Governs the C1–C9 items in `HANDOFF.md`. Settled 2026-09-03. This is *how* we
work the list; `HANDOFF.md` is *what's* on it.

---

## Definition of done (per fix)

Hybrid — automated where the logic is pure, manual where it's Obsidian-bound.

- **Unit tests (vitest)** for pure-logic modules: `lsp/roots.ts` resolution +
  deny-set, `lsp/transport.ts` framing / caps / reset counting, `session.ts`
  `DocumentSession` dirty math and peer bookkeeping, URI round-trips in
  `lsp/workspace.ts`. Every fix that touches these ships with a test that fails
  before and passes after.
- **Manual smoke checklist** (`SMOKE.md`, committed) for anything that needs a
  real leaf / real vault: leaf-close teardown, `setViewData` re-entry, primary
  election, diagnostics landing in the right pane, restart command. Each fix
  appends its reproduction + expected result as new checklist lines. A recorded
  run of the affected section goes in the commit / PR body.
- **Gates:** `npm run build` (tsc `--noEmit` + esbuild) clean, `npm run lint`
  (`eslint-plugin-obsidianmd`) clean.
- **Store invariants re-checked** for any fix touching spawn / fs / teardown:
  `isDesktopOnly`, no fs side effect without explicit user action, `child_process`
  only from user-configured commands, full cleanup in `onunload`.
- **Bookkeeping:** strike the item in `HANDOFF.md`; push any genuine residual to
  `NOTES.md` rather than leaving it half-done in the handoff.

Harness (done): `vitest` (pinned `^3` — v5 pulls an esbuild that conflicts with
the bundler's `^0.24`), `test/mocks/obsidian.ts` aliased for `obsidian` in
`vitest.config.mts`, `npm test` / `npm run test:watch`. Tests live in `test/`,
not `src/`, so the production `tsc --noEmit` in `build` stays fast and green;
`vitest` transpiles per-file, so type errors in tests surface as run failures,
not build failures. Grow the mock as tests reach further in.

---

## Sequencing — three subsystem passes

Grouped so related items share one coherent design change instead of re-touching
each other. Passes are ordered; items within a pass land together in one branch.

### Pass 1 — LSP lifecycle: C1 + C7 + C8 ✅ landed

- **C1** — `LspRegistry` gets per-entry status (`starting | running | crashed |
  absent`) + a listener the sessions / status bar subscribe to. On unexpected
  `exit`: keep a tombstone, auto-restart with backoff (cap ~3), else mark
  `crashed`, `Notice` once, add a status-bar item + "Onyx: Restart language
  server" command → `registry.restart(realRoot, languageId)` that re-applies
  `client.plugin` to affected primaries. `acquire()` / `resolveServer` return a
  *reason* on failure ("LSP disabled" vs "no binary for `<languageId>` — looked
  in .venv/bin, node_modules, PATH"); `Notice` the no-binary case once per
  project+lang.
- **C7** — cap `transport.buf` (~32 MB) and `expected` (~64 MB). On breach: log
  the offending bytes, reset `buf`/`expected`, count it; after N resets in a
  window tear the transport down and report through C1's status channel.
- **C8** — if the resolved project root is `homedir()` or an ancestor of it,
  refuse to start a project-indexing server: fall back to single-file mode or
  require explicit opt-in. Deny-set = `~` and its immediate children.
- Tests: transport framing + cap + reset-count (feed byte streams); roots
  deny-set; `resolveServer` reason. Manual: kill a running server mid-session →
  Notice + working restart; open a file with no server installed → exactly one
  Notice naming the language.

### Pass 2 — multi-view: C2 + C6 + C3 ✅ landed

Prefer the real fix (see below). C2 got the real multi-view `Workspace`; C6 got
the agreed short-term `addToHistory: false` (shared undo stack still deferred);
C3 got idempotent `onClose` teardown + the `onLoadFile` reorder. Build note:
`tsconfig.json` gained `paths` for `@codemirror/state|view|lint` to collapse the
duplicate type identities npm nests under lint/lsp-client (runtime already
externalizes them; this is types-only).

- **C2** — make `ObsidianWorkspace` genuinely multi-view: `Set<EditorView>` per
  `WorkspaceFile`, elect a "main" for `getView()`, fan `updateFile` + diagnostics
  dispatch to every view, `didClose` only when the last one goes. Every peer
  carries `client.plugin(...)`. Collapses the `primary` special-case in
  `DocumentSession` to just the main-election.
- **C6** — mirrored changes dispatch with `addToHistory: false` so each view
  undoes only its own edits. True shared history stays a `NOTES.md` #10 line.
- **C3** — `onClose` defensively calls `session?.detach(this)` +
  `releaseSession(...)` (idempotent). Pin down whether Obsidian can run `onClose`
  without a preceding `onUnloadFile` and handle it. Guard the
  `setViewData(clear=true)` → `setState` teardown against the async
  `attach → adoptPrimary` re-add.
- Tests: `DocumentSession` peer add/remove, dirty recompute across peers, detach
  idempotency. Manual: open A / split A / close original → split keeps LSP; close
  both → server refs hit 0; rapid A→B→A in one leaf → no duplicate `didOpen`, no
  orphan `WorkspaceFile`.

### Pass 3 — save & disk: C4 + C5 ✅ landed

C5: `DocumentSession` owns the `afterDelay` debounce (configurable
`autoSaveDelayMs`), `didSave` on every dirty-clearing save. Native tab dot
skipped (private API) — status bar is the dirty surface. C4: `ExternalChangeModal`
reload/keep prompt, autosave suspended while it's open. Test harness gained
`test/setup.ts` (aliases `window`→`globalThis` for `window.setTimeout` under
node) and a fuller `obsidian` mock (`Modal`, chainable `Setting`).

- **C5** — real debounced save with a visible dirty window (configurable delay);
  `onFocusChange` / `off` policies as already sketched in `settings.ts`. Surface
  dirty on the tab (dot for close-X) and a status-bar item. On a confirmed
  `CodeView.save()` write, send `textDocument/didSave` through the session's
  client (`session.markSaved()` → LSP hook).
- **C4** — on an external on-disk change while the buffer is `dirty`: modal /
  inline banner — **Reload from disk** vs **Keep my version** (vs a diff view
  later). Never a silent drop.
- Tests: dirty windowing with fake timers, save-policy branching,
  `markSaved` → `didSave` hook fired. Manual: edit + `git checkout` underneath →
  prompt appears, both choices behave; a format-on-save server reacts to
  `didSave`.

---

## Stopgap vs. real fix

**Prefer the real fix.** Pre-1.0 (`v0.0.1`), no users, and the known stopgaps
(re-elect primary on focus, Notice-only on dropped disk change) are documented as
jarring. Where the architectural change is bounded — C2 multi-view `Workspace`,
C4 reload-vs-keep prompt — do it now rather than growing `NOTES.md` #10. C6 is
cheap either way (`addToHistory: false`); full shared history remains deferred.
If a "real fix" turns out unbounded once in focus, call it out and fall back to
the stopgap for that one item deliberately, not by default.

---

## Out of scope for this pass

- **Feature gaps** — everything in `NOTES.md` (references, rename, format,
  outline, external read-only view, …). A correctness fix may only pull in a
  NOTES item when it's the *bounded* architectural fix for the C-item in hand
  (C2 ↔ NOTES #10).
- **C9 / Windows** — declared unsupported in the manifest for now. No fix budget;
  revisit when someone actually runs it.
- **"Verified NOT a problem"** section of `HANDOFF.md` — trusted as-is, not
  re-investigated. If a Pass turns up counter-evidence, reopen it explicitly.
