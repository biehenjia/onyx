# Architecture

Onyx is organized around a small composition root and feature modules with
one-way dependencies.

## Boundaries

- `src/main.ts` wires Obsidian lifecycle events, commands, views, and services.
  It may depend on every feature module; feature modules must not import it.
- `src/editor/` owns contracts and primitives shared by the editor view,
  document sessions, and integrations. Keep these interfaces capability-based
  so consumers do not need the concrete plugin or view classes.
- `src/session.ts` owns per-document state: peer synchronization, dirty state,
  save policy, conflict handling, recovery callbacks, and LSP attachment. It is
  independent of Obsidian UI classes.
- `src/lsp/` owns protocol framing, process transport, server discovery,
  project roots, client lifecycle, and workspace navigation. UI access enters
  through the narrow host contract in `workspace.ts`.
  `setup.ts` discovers the nearest explicit `onyx.toml` project and is the
  composition boundary for canonical paths, URIs, language ids, commands, and
  registry keys. `servers.ts` only validates and launches that approved argv;
  it does not guess servers, environments, project markers, or PATH entries.
- UI modules (`explorer.ts`, `symbols.ts`, settings, and modals) render and
  collect user intent. Dependencies on application behavior should be passed in
  as callbacks or small host interfaces.
- Leaf utilities (`git.ts`, `lint.ts`, `languages.ts`, and editor extensions)
  should remain independently testable and avoid importing UI modules.

## Dependency direction

```text
main (composition root)
  -> views / UI adapters
  -> session
  -> integrations (LSP, Git, lint)

views / session / integrations
  -> editor contracts and leaf utilities
```

Avoid barrel files inside these boundaries: direct imports make dependencies
visible and reduce accidental cycles. If two features need the same concept,
put a minimal contract in the lower-level owner rather than importing one
feature's concrete class from another.

## Next extractions

`main.ts` still contains the concrete `CodeView` and several coordinators. The
next low-risk steps are to move `CodeView` into `src/editor/code-view.ts`, then
extract lint scheduling and recovery persistence into lifecycle-owned services.
Those moves should preserve `main.ts` as the only place that constructs and
connects them.
