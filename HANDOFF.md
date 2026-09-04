# Handoff — correctness debt (LSP core + multi-view)

**Scope:** risks and known-wrong behaviour in the code that landed with the LSP
core unlock and go-to-definition. Snapshot taken 2026-09-03. Feature gaps
(references, rename, format, outline, external read-only view, …) are in
`NOTES.md`, not here — this file is only about things that are subtly broken or
will break under normal use.

Items are IDed `C1`…`Cn`, roughly priority order. Each has: where it lives, how
it shows up, why, and a fix direction.

Working policy for this pass: `CORRECTNESS-POLICY.md`. Manual verification steps:
`SMOKE.md`. Progress: **all three passes landed** — Pass 1 (C1, C7, C8), Pass 2
(C2, C3, C6), Pass 3 (C4, C5); see per-item Status notes. C9 declared
unsupported (manifest). This correctness pass is complete.

---

## C1 — A crashed or missing server dies silently, with no recovery

**Status: DONE (Pass 1).** `LspRegistry` now tracks lifecycle
(`starting|running|crashed|absent`) and exposes `onChange`. Unexpected exits
auto-restart with backoff (`[500, 2000, 5000] ms`, cap 3 per healthy window),
then become a `crashed` tombstone. `resolveServer` returns `{ok:false, reason}`;
`main.ts` shows a one-shot `Notice` per project+language for a missing binary, a
`Notice` on crash, an `◌/⚠` status-bar item, and an **Onyx: Restart language
server** command. Sessions re-bind via `DocumentSession.resyncLsp()` on `running`.
Residual: a manual restart that revives a never-had-a-binary tombstone can leave
the entry ref-held at 0 (self-heals on file close); revisit with the Pass 2
primary/peer rework.

**Where:** `src/lsp/transport.ts:34-42` (spawn `error` / `exit` → `onClosed`),
`src/lsp/registry.ts:70` + `102-113` (`drop`), `src/lsp/servers.ts:104-134`
(`resolveServer` returns `null`), `src/session.ts:80-89` (`adoptPrimary`).

**Symptom:**
- Open a `.py`/`.cpp` file with no server installed → no hover/diagnostics, and
  **nothing tells you why** (LSP off? no binary? server crashed?). Only
  `console.warn`, and only for an explicit settings override that fails to
  resolve — an auto-detect miss is completely silent.
- `clangd` crashes mid-session (bad `compile_commands.json`, OOM) → the child
  exits, `registry.drop(key)` deletes the entry and disconnects the client, but
  the open `CodeView` still has that dead `client.plugin(...)` in its
  `lspCompartment`. Requests now hang until the 3 s timeout, diagnostics freeze.
  No restart, no notice.
- Inconsistency after a crash: opening a *new* file in the same project
  re-`acquire`s → a fresh entry → a fresh spawn. New files work, already-open
  files stay dead.

**Why:** the registry treats "child exited" as "drop everything" and never tells
the sessions holding that client. `resolveServer` failing is a normal `null`
return with no user-facing channel.

**Fix direction:**
- Give `LspRegistry` a status per entry (`starting | running | crashed | absent`)
  and a listener the sessions/status bar subscribe to.
- On unexpected `exit`, keep the entry (or a tombstone) and either auto-restart
  with backoff (cap ~3 tries) or mark it `crashed` and surface a `Notice` +
  status-bar item with a "Restart language server" command.
- On `adoptPrimary`, when `acquire()` returns `null`, distinguish "LSP disabled"
  from "no binary found for `<languageId>` — looked in .venv/bin, node_modules,
  PATH, …" and `Notice` the latter once per project/lang.
- `resolveServer` should return a reason on failure, not just `null`.
- Add an `onLayoutReady`/command "Onyx: Restart language server" that calls a new
  `registry.restart(realRoot, languageId)` and re-applies `client.plugin` to the
  primary views of affected sessions.

---

## C2 — Peer views of the same file have no language server

**Status: DONE (Pass 2).** Took fix direction (1). `ObsidianWorkspace` is now
genuinely multi-view: `OnyxWorkspaceFile` holds a `Set<EditorView>`,
`openFile`/`closeFile` reference-count `didOpen`/`didClose`, `getView` elects the
oldest pane (or the `main` hint) as sync/diagnostics source. `DocumentSession`
lost the `primary` concept — every attached view carries its own
`client.plugin(...)`, so hover/completion/signature help work in every pane.
Diagnostics land on the elected view and are mirrored to peers by replaying the
`setDiagnosticsEffect` (`DocumentSession.mirrorDiagnostics` →
`CodeView.applyMirroredDiagnostics`). `detach` flushes `client.sync()` while all
plugins are still mounted so a successor sync-source starts even. Residuals:
diagnostics on a *former* elected view go stale until the next publish;
per-pane `autoSync` means N redundant `sync()` calls after a mirrored edit
(first does the work).

**Where:** `src/session.ts:80-89` (`adoptPrimary` — only `primary` gets
`client.plugin`, peers get `[]`).

**Symptom:** open a file, then open it again in a split. One pane has
hover/completion/diagnostics, the other has nothing. Diagnostics underlines only
appear in whichever pane happens to be primary.

**Why:** deliberate v1 simplification — lsp-client's workspace model is
one-editor-per-file, and routing the server through a single view keeps
didOpen/didChange/didClose coherent. `ObsidianWorkspace` already tolerates the
URI being re-hosted on a different view (`openFile` swaps `existing.view`), but
still only *one* view at a time.

**Fix direction:** two options.
1. Make `ObsidianWorkspace` genuinely multi-view: track a `Set<EditorView>` per
   `WorkspaceFile`, pick a "main" for `getView()`, fan `updateFile`/diagnostics
   dispatch out to all of them, only `didClose` when the last one goes. Then
   every peer can carry `client.plugin(...)`.
2. Cheaper stopgap: keep single-host, but on `active-leaf-change` re-elect the
   focused peer as primary (move the compartment) so at least the pane you're
   working in always has LSP. Jarring if diagnostics visibly jump panes.

Prefer (1); it also unblocks NOTES.md #10.

---

## C3 — Primary re-election and leaf-close teardown are under-tested

**Status: DONE (Pass 2).** `CodeView.onClose` now runs the same session
teardown as `onUnloadFile` (`flush` → `detach` → `releaseSession`), and both
`DocumentSession.detach` and `plugin.releaseSession` are idempotent, so a missed
`onUnloadFile` before `onClose` no longer leaks a session/server and the normal
double call is a no-op. The Obsidian ordering guarantee is still unverified from
code — the defensive path just makes it not matter. `onLoadFile` now adopts a
joining peer's buffer *before* `attach()` (the buffer copy is a full `setState`
that would otherwise tear down the LSP plugin `attach` just added). `detach`
re-election is covered by `test/session.test.ts` and the multi-view flow by
`test/lsp/workspace.test.ts`; the rapid-file-switch case is in `SMOKE.md`.

**Where:** `src/session.ts:60-71` (`detach` → synchronous `adoptPrimary(next)`),
`src/main.ts` `onUnloadFile` (calls `session.detach` **before** editor destroy)
vs `onClose` (`this.editor.destroy()` only, **no** `session.detach`).

**Symptom / risk:**
- If Obsidian ever runs `onClose` for a file-bearing leaf **without** a preceding
  `onUnloadFile`, the session keeps a destroyed-editor `CodeView` in
  `this.views` forever, still marked `primary`, and `plugin.sessions` never drops
  the entry → session + possibly server leak. **Unverified** whether Obsidian
  guarantees `onUnloadFile` before `onClose` on leaf close.
- `setViewData(data, clear=true)` → `editor.setState(buildState(...))`
  (`src/main.ts:77-78`) tears down and recreates *all* view plugins, including
  the `LSPPlugin` in `lspCompartment`, which fires `workspace.closeFile`. On a
  fast file switch in one leaf this interleaves with the async
  `session.attach → adoptPrimary` that re-adds the plugin. Currently ordered OK
  (super.onLoadFile → setState → then attach), but it's fragile.

**Fix direction:**
- Make `onClose` defensively call `this.session?.detach(this)` +
  `plugin.releaseSession(...)` (idempotent — `detach` on an already-removed view
  is a no-op).
- Add a regression check: open A, split to A, close the original → the split must
  keep working LSP; close both → server ref hits 0.
- Add: rapidly switch A→B→A in one leaf → no duplicate `didOpen`, no orphaned
  `WorkspaceFile` in `ObsidianWorkspace.files`.

---

## C4 — External on-disk change is dropped when the buffer is dirty

**Status: DONE (Pass 3, real fix).** `handleExternalChange` now: clean buffer →
adopt disk (unchanged); disk == buffer → just reconcile `savedText`; disk ==
last-saved baseline → no-op; genuine conflict → `ExternalChangeModal`
(`src/conflict.ts`) with **Reload from disk** / **Keep my version**, dismissal
counts as keep. Autosave is suspended while the prompt is open and resumed on
resolve, so a pending timer can't overwrite the change under review. A second
disk change during the prompt is held and re-evaluated after. Injected as
`ConflictPrompt` so `DocumentSession` stays UI-free; covered in
`test/session.test.ts`.

**Where:** `src/session.ts:122-129` (`handleExternalChange` — `if (this.dirty)
return;`).

**Symptom:** file has unsaved edits in Onyx; something else (git checkout,
formatter, another editor) rewrites it on disk. Onyx silently ignores the disk
version. The next autosave (~2 s after you stop typing, see C5) overwrites the
disk change with the editor buffer. Data loss with no prompt.

**Why:** NOTES.md #10 — the reload-vs-keep prompt was scoped out.

**Fix direction:** when `dirty` and an external change arrives, show a modal /
inline banner: **Reload from disk** (discard editor edits) vs **Keep my version**
(mark dirty, next save wins) vs a diff view. Until then, at minimum `Notice` that
a disk change was ignored so it isn't silent.

**LSP note:** when `!dirty`, `handleExternalChange` replaces buffer contents via a
`mirroredEdit`-annotated dispatch; that *is* a `docChanged` update, so
`LSPPlugin` accumulates it and `autoSync` (500 ms) pushes `didChange`. So the
server does track external changes in the non-dirty case — no action needed
there.

---

## C5 — Autosave-on-keystroke leaves no real dirty window; no `didSave`

**Status: DONE (Pass 3).** `DocumentSession` now owns the `afterDelay` debounce
(`scheduleSave`/`cancelScheduledSave`) instead of calling Obsidian's fixed-2 s
`requestSave` on every keystroke — one save per pause, at a configurable delay
(`autoSaveDelayMs`, default 2000, slider in settings). `flush`/`markSaved`/last
`detach`/`onunload` all cancel a pending timer. `onFocusChange` flushes on blur;
`manual` only on Cmd-S. `markSaved` sends `textDocument/didSave` (uri only, no
`includeText` negotiation) whenever a save cleared a dirty buffer. `CodeView`
lost `requestNativeSave`. **Deviation:** the native tab "unsaved dot" is driven
by a private Obsidian field and is *not* wired (store-review discipline) — dirty
is surfaced via the status-bar item, which now has a real window.

**Where:** `src/settings.ts` (`savePolicy: "afterDelay"` default),
`src/session.ts:107-109` (`requestNativeSave()` on every change under
`afterDelay`).

**Symptom:** the file is written ~2 s after every pause in typing. `this.dirty`
is true only for that ~2 s, so the tab dirty-dot / status-bar item barely ever
shows. Interacts with C4 (autosave clobbers external changes fast).

**Also:** no `textDocument/didSave` is ever sent — lsp-client doesn't send it and
neither do we. Servers/tools keyed on save (ruff format, clang-tidy full-file
lint, `willSaveWaitUntil` format-on-save) never fire.

**Fix direction:**
- Make the debounced-save actually debounced with a visible dirty window
  (`files.autoSave: afterDelay` semantics, configurable delay), plus
  `onFocusChange` / `off`. Session-level dirty flag already exists; surface it on
  the tab (dot instead of the close X) and status bar.
- After a confirmed `CodeView.save()` write, send `textDocument/didSave` through
  the session's client (needs a hook from `session.markSaved()` into the LSP
  layer, or an explicit `client.notification("textDocument/didSave", …)`).

---

## C6 — Multi-view undo histories diverge

**Status: DONE (Pass 2, short-term fix).** Mirrored edits now dispatch with
`Transaction.addToHistory.of(false)` (`CodeView.applyMirroredChanges` and the
`setEditorText` replace path), so each pane's `history()` only records its own
local typing — undo in B no longer reverts A's edit. Content stays in sync
because every edit is still mirrored. A true shared undo stack stays deferred
(NOTES.md #10).

**Where:** `src/main.ts` `baseExtensions` (`history()` per view),
`src/main.ts` `applyMirroredChanges` (dispatch **without**
`addToHistory: false`), `src/session.ts:101-104`.

**Symptom:** edit in pane A; the mirrored change lands in pane B's undo history
too. Undo in B reverts A's typing (as a local edit that then mirrors back to A as
a *forward* change). Content stays in sync because every change is always
mirrored, but redo/undo interleaving between panes is unpredictable and
surprising.

**Why:** each view has its own `history()`; mirrored changes aren't excluded from
history and there's no shared stack.

**Fix direction:** short term — dispatch mirrored changes with
`addToHistory: false` so only the originating view can undo its own edit (matches
"selection/scroll stay per-view"). Long term — a shared history (custom, or the
`@codemirror/collab` rebasing approach). NOTES.md #10.

---

## C7 — Transport framing has no back-pressure or sanity caps

**Status: DONE (Pass 1).** Framing moved to `src/lsp/framing.ts` (`LspFramer`,
unit-tested). Caps: 32 MB unframed buffer, 64 MB declared `Content-Length`; on
breach it logs a sample, resets, and counts; after 5 resets it calls `onFatal`,
which kills the child and routes through C1's crash/restart path. Byte-length
slicing was already correct.

**Where:** `src/lsp/transport.ts:77-101` (`ingest`).

**Risk:** a server that writes non-LSP bytes to **stdout** (a stack trace, a
crash dump, a stray `print`) with no `\r\n\r\n` makes `this.buf` grow unbounded —
`ingest` just returns and waits. A garbage `Content-Length: 999999999` header
makes it accumulate forever waiting for bytes that never come. Neither is
recoverable without closing the transport.

**Fix direction:** cap `this.buf` (e.g. 32 MB) and `expected` (e.g. 64 MB); on
breach, log the offending bytes, reset `buf`/`expected`, and count it — after N
resets in a window, tear the transport down and report via C1's status channel.
Byte-length slicing / UTF-8 at chunk boundaries is already correct (server
`Content-Length` is bytes, we slice the Buffer then decode) — no bug there.

---

## C8 — `resolveProject` can root a server at `$HOME`

**Status: DONE (Pass 1).** `resolveProject` returns `null` (no LSP) when the
resolved root is `$HOME` or any ancestor (`isUnsafeRoot`, exported + unit-tested),
and also when a marker-less loose file resolves to an immediate subdirectory of
`$HOME` (`~/Desktop/scratch.py`). A real marker under `~` (`~/repo/.git`) still
roots normally. Deviation from the original note: immediate children of `~` are
*not* blanket-denied — only the marker-less fallback case — so single-directory
projects keep working.

**Where:** `src/lsp/roots.ts` `resolveProject` (walk stops at `homedir()` / fs
root; fallback root is the file's own dir).

**Risk:** open a loose script sitting directly in `~` (or any dir with no marker
up to `~`) → root = that dir, which may be `~`. `clangd --background-index` or
`gopls` rooted at `$HOME` will try to index your entire home directory.

**Fix direction:** if the resolved root is `homedir()` or a parent of it, refuse
to start a project-indexing server (or fall back to single-file mode / require an
explicit opt-in). Add `~` and its immediate children to a deny set.

---

## C9 — Windows / unusual paths unverified

**Where:** `src/lsp/roots.ts` (`VaultMap.toVaultPath` string-prefix compare with
`sep`), `src/lsp/workspace.ts` (`fileURLToPath` / URI round-trip),
`src/lsp/servers.ts` (`EXE_SUFFIXES`, `.bin` layout).

**Risk (all untested):** drive-letter case (`C:\` vs `c:\`) breaking the
`startsWith` prefix match; `%`/`#`/spaces/unicode in paths through the
`pathToFileURL` ↔ `fileURLToPath` ↔ `TFile.path` comparisons in `findOpenView`;
`node_modules/.bin` shims being `.cmd` wrappers on Windows.

**Fix direction:** normalise case on Windows before prefix comparison; add a test
matrix of paths with spaces/unicode/`#`; treat Windows as explicitly unsupported
in the manifest until someone runs it.

---

## Verified NOT a problem (don't re-investigate)

- **Diagnostics do refresh while typing.** `serverDiagnostics()` bundles an
  `autoSync` ViewPlugin that debounces `client.sync()` 500 ms after `docChanged`
  (`@codemirror/lsp-client` dist ~line 1793). We get it for free via the client
  `extensions`.
- **Pre-init notifications are safe.** `LSPClient.notification()` and
  `request()` both chain off `this.initializing`, so `didOpen`/`didChange` sent
  right after `client.connect()` queue until `initialize` completes.
- **Mirrored-edit UTF-8 / large replace** in `setEditorText` is a normal CM
  change dispatch; no encoding hazard.
- **`ObsidianWorkspace.closeFile(uri, view)`** guards on `file.view !== view`, so
  the old primary's editor teardown during re-election doesn't `didClose` a file
  the new primary just re-opened.
