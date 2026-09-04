# Manual smoke checklist

Steps that need a real Obsidian leaf / vault / language server and so aren't
covered by `npm test`. Run the relevant section after touching that subsystem
and paste the result into the commit / PR body. Grows per correctness fix
(`CORRECTNESS-POLICY.md`).

Setup: a vault with a project that has a working language server (e.g. a Python
project with `pyright-langserver`, or TS with `typescript-language-server`), and
one language with **no** server installed (e.g. a `.go` file, no `gopls`).

---

## Pass 1 — LSP lifecycle (C1, C7, C8)

### C1 — crash surfaces and recovers

- [ ] Open a project file with a working server. Hover works, diagnostics show.
- [ ] Kill the server process externally (`kill <pid>` / `pkill pyright`).
      → within a second the status bar shows `◌ LSP starting`, then hover works
      again with no reopen. The child PID has changed.
- [ ] Kill it 4+ times in quick succession.
      → after the cap, a `Notice` "…language server — …gave up after 3 restarts"
      and the status bar shows `⚠ LSP crashed`.
- [ ] Run the command **Onyx: Restart language server**.
      → status returns to normal, hover works again.

### C1 — missing binary is explained, not silent

- [ ] Open the `.go` file (no `gopls`).
      → exactly one `Notice`: "no go language server found (looked for gopls …)".
      Editing still works; no hover.
- [ ] Open a second `.go` file in the same project.
      → **no** second notice.
- [ ] Install `gopls`, run **Onyx: Restart language server** on the `.go` file.
      → server starts, hover appears. (Reopening the file also works.)

### C1 — peers / re-election unaffected

- [ ] Open file A (server up). Split so A is open twice. Close the original leaf.
      → the surviving pane still has hover/diagnostics.
- [ ] Close all A leaves, reopen A after ~1s.
      → server still there (ref-held) or restarts cleanly; no duplicate servers
      in the process list.

### C7 — transport can't be wedged by junk on stdout

- [ ] Point an override at a wrapper that prints a few KB of non-LSP text to
      stdout before exec'ing the real server
      (`data.json` → `"lspServers": {"python": ["/path/to/wrapper"]}`).
      → server still initializes; the junk is logged to the console, not fatal.
- [ ] (Optional) wrapper that only ever prints garbage, never LSP frames.
      → after several MB it resets (console error), and after repeated resets the
      transport tears down → C1 crash/restart path.

### C8 — no server rooted at $HOME

- [ ] Put a lone `~/scratch.py` (no project markers anywhere up to `~`). Open it.
      → **no** language server starts, no background indexing of `$HOME`.
      No crash, editing works.
- [ ] `~/Desktop/scratch.py`, still no markers. Open it.
      → same: no server.
- [ ] A real project at `~/some-repo/` (has `.git`). Open a file in it.
      → server starts normally, rooted at `~/some-repo`.

---

## Pass 2 — multi-view (C2, C3, C6)

Setup: a project file with a working server, opened in **two panes** (open, then
`Cmd`-click the tab → Split, or open the same file in a new pane).

### C2 — LSP works in every pane

- [ ] Hover a symbol in pane A → tooltip. Hover the same symbol in pane B →
      tooltip. (Before: only one pane responded.)
- [ ] Trigger completion in pane B → results. Signature help in pane B → popup.
- [ ] Introduce an error (e.g. `let x: number = "s"`). Both panes show the red
      underline + gutter marker, not just one.
- [ ] Fix the error → underline clears in both panes.
- [ ] Type in A → B updates live (unchanged from before). Diagnostics re-run and
      land in both.

### C2 / C3 — teardown and re-election

- [ ] Two panes on file A. Close the **original** pane. The surviving pane keeps
      hover / completion / diagnostics (it became the sync source).
- [ ] Type a few chars in the original pane and immediately `Cmd-W` it. The
      surviving pane still has the text; edit there and confirm diagnostics
      still track (no server desync — check the console for LSP errors).
- [ ] Close the second pane too. In the process list the server ref drops; after
      the idle timeout (or immediately on plugin reload) the process exits.
- [ ] One leaf, rapidly switch file A → B → A (same leaf). No duplicate
      `didOpen` for A, no console errors, hover still works on A.

### C6 — undo is per-pane

- [ ] Two panes on file A. Type `foo` in pane A (appears in both).
- [ ] Focus pane B, press `Cmd-Z`. It undoes **pane B's** last local edit (or
      does nothing if B has made none) — it does **not** roll back the `foo`
      typed in A.
- [ ] Type `bar` in B, `Cmd-Z` in B → removes `bar` in both panes. `Cmd-Z` in A
      → removes `foo`. Content stays identical in both panes throughout.

---

## Pass 3 — save & disk (C4, C5)

### C5 — real dirty window + configurable delay

- [ ] Settings → Save = "After delay", delay slider = e.g. 3 s.
- [ ] Type in a file, stop. Status bar shows `● Unsaved` for ~3 s, then the file
      is written and the indicator clears. (Confirm the write with
      `stat`/`ls -l` or an external tail.)
- [ ] Keep typing continuously > 3 s → no mid-stream save; it writes ~3 s after
      you stop.
- [ ] Save = "On focus change": type, click another pane/app → writes on blur.
- [ ] Save = "Manual only": type, wait → no write; `Cmd-S` → writes.
- [ ] Close a tab with unsaved edits → still flushed to disk (onUnloadFile).

### C5 — didSave to the server

- [ ] With a server that acts on save (e.g. `ruff` configured to format on
      save, or watch the LSP traffic): edit + let it save → a
      `textDocument/didSave` notification goes out (console / server log).

### C4 — external change while dirty

- [ ] Edit a file in Onyx (leave it dirty, within the delay window or use
      Manual). In a terminal, `echo "// changed" >> thatfile`.
- [ ] Onyx shows the **File changed on disk** modal. **Keep my version** →
      buffer unchanged, still dirty; next save overwrites disk with your text.
- [ ] Repeat, choose **Reload from disk** → buffer becomes the disk content,
      indicator clears.
- [ ] Repeat, dismiss the modal with `Esc` → treated as "keep" (edits retained).
- [ ] While the modal is open, confirm no autosave fires (watch the file mtime);
      after you resolve, autosave resumes.
- [ ] Clean buffer + external change (no unsaved edits) → no modal, buffer
      updates to disk content silently, server gets the change.

---

## Hover / signature highlighting

- [ ] Hover a symbol whose doc contains a fenced code block (e.g. a Python
      function with an example, or any TS symbol — the type signature block).
      The code is syntax-coloured with the same palette as the editor, not flat.
- [ ] Trigger signature help inside a call. The parameter the cursor is on is
      bold + coloured (`.cm-lsp-active-parameter`).
- [ ] Cross-language: in a `.py` file, hover something whose doc embeds a
      ```json / ```bash block → that block highlights too (via `languageByName`,
      not the file's own language).
- [ ] C++: hover a function. clangd's **"Parameters:" bullet list** (inline
      `code`, not the fenced block) is now syntax-coloured — type names /
      keywords stand out — matching the fenced signature block below it, not
      flat monospace. Inline `code` in prose (`std::foo`) is coloured too.
      (`highlightDocCodeInto`.)
