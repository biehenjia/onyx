import { ChangeSet } from "@codemirror/state";
import type { LSPClient } from "@codemirror/lsp-client";
import type { Diagnostic } from "@codemirror/lint";
import type { ConflictChoice } from "./conflict";
import type { SessionView } from "./editor/contracts";
import type { SavePolicy } from "./settings";

/**
 * Ask the user how to resolve a disk-vs-buffer conflict (see C4). Must call
 * `resolve` exactly once. Injected so the session stays UI-agnostic.
 */
export type ConflictPrompt = (
	path: string,
	resolve: (choice: ConflictChoice) => void,
) => void;

/** Fallback when no prompt is wired (tests): never discard the editor's edits. */
const keepMinePrompt: ConflictPrompt = (path, resolve) => {
	console.warn(
		`Onyx: "${path}" changed on disk with unsaved edits and no conflict prompt is wired; keeping the editor version.`,
	);
	resolve("keep");
};

/**
 * Everything a session needs to attach a language server to its views. Built by
 * the plugin (which knows the vault adapter and settings) and handed to the
 * session so the LSP lifecycle rides the session lifecycle.
 */
export interface LspBinding {
	/** `file://` URI of the real (symlink-resolved) file path. */
	fileUri: string;
	/** LSP language id for `textDocument/didOpen`. */
	languageId: string;
	/** Canonical project root the server is keyed on. */
	realRoot: string;
	/** Start/join the shared server; `null` if no server binary was found. */
	acquire(): LSPClient | null;
	/** Current shared client without changing the refcount (post-restart re-bind). */
	current(): LSPClient | null;
	/** Drop this session's reference to the shared server. */
	release(): void;
}

/**
 * Shared per-file state for every `CodeView` open on the same path: the live
 * peer set, the saved-vs-current comparison that drives the dirty indicator, the
 * save scheduling that a single view shouldn't own, and the language-server
 * connection.
 *
 * Every attached view carries its own `client.plugin(...)` — the multi-view
 * `ObsidianWorkspace` reference-counts didOpen/didClose and elects one view as
 * the sync/diagnostics source, so hover, completion and signature help work in
 * every pane. Diagnostics land on the elected view and are mirrored to peers
 * (see {@link mirrorDiagnostics}).
 *
 * One instance per path, created and dropped by the plugin's session registry.
 */
export class DocumentSession {
	private views = new Set<SessionView>();
	/** Contents as of the last successful write (or initial load). */
	private savedText: string;
	dirty = false;

	/** Held for the session's lifetime once acquired; released on last detach. */
	private lspClient: LSPClient | null = null;

	/** Pending `afterDelay` autosave. */
	private saveTimer: number | null = null;

	/** A conflict prompt is on screen; hold further disk changes. */
	private conflictOpen = false;
	private pendingExternalText: string | null = null;

	constructor(
		readonly path: string,
		initialText: string,
		private getPolicy: () => SavePolicy,
		private onDirtyChange: () => void,
		private lsp: LspBinding | null = null,
		private getAutoSaveDelayMs: () => number = () => 2000,
		private promptConflict: ConflictPrompt = keepMinePrompt,
		private persistRecovery: (path: string, text: string, diskText: string) => void = () => {},
		private clearRecovery: (path: string) => void = () => {},
	) {
		this.savedText = initialText;
	}

	get size(): number {
		return this.views.size;
	}

	attach(view: SessionView): void {
		this.views.add(view);
		this.bindLsp(view);
		this.recomputeDirty();
	}

	detach(view: SessionView): void {
		// Flush pending edits to the server while every view's LSP plugin is
		// still mounted, so if a peer takes over as the workspace's sync source
		// it starts from a synced baseline (guards a fast type-then-close).
		try {
			this.lspClient?.sync();
		} catch {
			/* server down — nothing to flush */
		}
		this.views.delete(view);
		if (this.views.size === 0) {
			this.cancelScheduledSave();
			if (this.lspClient) {
				this.lsp?.release();
				this.lspClient = null;
			}
		}
	}

	/** Hand `view` a fresh `client.plugin(...)` (or `[]` when there's no server). */
	private bindLsp(view: SessionView): void {
		if (!this.lsp) return;
		if (!this.lspClient) this.lspClient = this.lsp.acquire();
		view.setLspExtension(
			this.lspClient
				? this.lspClient.plugin(this.lsp.fileUri, this.lsp.languageId)
				: [],
		);
	}

	/** The `(realRoot, languageId)` this session's server is keyed on, if any. */
	get lspTarget(): { realRoot: string; languageId: string } | null {
		return this.lsp
			? { realRoot: this.lsp.realRoot, languageId: this.lsp.languageId }
			: null;
	}

	/** True when this session's server is the one keyed on `(realRoot, languageId)`. */
	usesServer(realRoot: string, languageId: string): boolean {
		return (
			!!this.lsp &&
			this.lsp.realRoot === realRoot &&
			this.lsp.languageId === languageId
		);
	}

	/**
	 * The shared server (re)started — swap the fresh client onto every view. A
	 * no-op when the client object is unchanged, so a spurious `running`
	 * emission for an unrelated pair doesn't churn this session's editors.
	 */
	resyncLsp(): void {
		if (!this.lsp) return;
		const next = this.lsp.current();
		if (next === this.lspClient) return;
		this.lspClient = next;
		for (const view of this.views) {
			view.setLspExtension(
				next
					? next.plugin(this.lsp.fileUri, this.lsp.languageId)
					: [],
			);
		}
	}

	/** Acquire a binding that became available after the view was attached. */
	connectLsp(): void {
		if (!this.lsp || this.lspClient) return;
		this.lspClient = this.lsp.acquire();
		if (!this.lspClient) return;
		for (const view of this.views) {
			view.setLspExtension(
				this.lspClient.plugin(this.lsp.fileUri, this.lsp.languageId),
			);
		}
	}

	/** Replace project configuration without recreating the document session. */
	replaceLspBinding(binding: LspBinding | null): void {
		if (this.lspClient) this.lsp?.release();
		this.lspClient = null;
		this.lsp = binding;
		for (const view of this.views) view.setLspExtension([]);
		this.connectLsp();
	}

	private get anyView(): SessionView | undefined {
		return this.views.values().next().value;
	}

	/** Live text — all peers are kept identical, so any view is authoritative. */
	get currentText(): string {
		return this.anyView?.getEditorText() ?? this.savedText;
	}

	/** A local edit in `origin`: mirror to peers, refresh dirty, schedule a save. */
	handleLocalChange(origin: SessionView, changes: ChangeSet): void {
		for (const view of this.views) {
			if (view !== origin) view.applyMirroredChanges(changes);
		}
		this.recomputeDirty();
		this.persistRecovery(this.path, this.currentText, this.savedText);

		if (this.getPolicy() === "afterDelay") {
			this.scheduleSave();
		}
		// onFocusChange -> saved on blur; manual -> saved on Cmd-S only
	}

	/** (Re)arm the debounced autosave. Owned here, not delegated to Obsidian's
	 *  fixed 2 s `requestSave`, so the delay is configurable and there's a real
	 *  dirty window (C5). Suspended while a disk-conflict prompt is open so an
	 *  autosave can't overwrite the change the user is deciding about (C4). */
	private scheduleSave(): void {
		this.cancelScheduledSave();
		if (this.conflictOpen) return;
		const delay = Math.max(0, this.getAutoSaveDelayMs());
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, delay);
	}

	private cancelScheduledSave(): void {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
	}

	/**
	 * Diagnostics were published to `origin` (the workspace's elected view) —
	 * replay them onto the peers so every pane shows the same underlines. Peer
	 * docs are kept byte-identical by mirroring, so the offsets carry over.
	 */
	mirrorDiagnostics(origin: SessionView, diagnostics: readonly Diagnostic[]): void {
		for (const view of this.views) {
			if (view !== origin) view.applyMirroredDiagnostics(diagnostics);
		}
	}

	notifyBlur(): void {
		if (this.getPolicy() === "onFocusChange") void this.flush();
	}

	/** Explicit save request (Cmd-S, plugin unload). */
	saveNow(): void {
		void this.flush();
	}

	/**
	 * On-disk change surfaced by Obsidian via setViewData(clear=false).
	 *
	 * Clean buffer → adopt the disk version (and the mirrored replace drives a
	 * `didChange` to the server for free). Dirty buffer → this is a conflict:
	 * ask, rather than silently dropping either side (C4).
	 */
	handleExternalChange(text: string): void {
		// Disk matches the baseline we last loaded/saved — no external change to
		// reconcile (Obsidian can re-fire setViewData with unchanged content).
		if (text === this.savedText) return;

		if (!this.dirty) {
			this.adoptDisk(text);
			return;
		}
		if (text === this.currentText) {
			// Disk caught up to our buffer — nothing in conflict.
			this.savedText = text;
			this.recomputeDirty();
			return;
		}
		if (this.conflictOpen) {
			this.pendingExternalText = text;
			return;
		}
		this.conflictOpen = true;
		try {
			this.promptConflict(this.path, (choice) =>
				this.resolveConflict(choice, text),
			);
		} catch (err) {
			console.error("Onyx: conflict prompt failed:", err);
			this.conflictOpen = false;
		}
	}

	private resolveConflict(choice: ConflictChoice, diskText: string): void {
		if (choice === "reload") {
			this.adoptDisk(diskText);
		} else {
			// Keep the editor buffer; next save overwrites disk.
			this.savedText = diskText;
			this.recomputeDirty();
		}
		this.conflictOpen = false;
		// Resume autosave now the conflict is settled (a kept version still
		// needs writing; a reloaded version is already clean).
		if (this.dirty && this.getPolicy() === "afterDelay") {
			this.scheduleSave();
		}
		if (this.pendingExternalText !== null) {
			const next = this.pendingExternalText;
			this.pendingExternalText = null;
			this.handleExternalChange(next);
		}
	}

	/** Replace every view's buffer with the on-disk text and mark clean. */
	private adoptDisk(text: string): void {
		this.savedText = text;
		for (const view of this.views) view.setEditorText(text, false);
		this.recomputeDirty();
		this.clearRecovery(this.path);
	}

	/** Called by CodeView.save() after a successful write, whatever triggered it. */
	markSaved(): void {
		this.cancelScheduledSave();
		const wasDirty = this.dirty;
		this.savedText = this.currentText;
		this.recomputeDirty();
		this.clearRecovery(this.path);
		if (wasDirty) this.sendDidSave();
	}

	/** Tell the language server the file was persisted (C5) — servers keyed on
	 *  save (format-on-save, full-file lint) need this; lsp-client never sends it. */
	private sendDidSave(): void {
		if (!this.lspClient || !this.lsp) return;
		try {
			this.lspClient.notification("textDocument/didSave", {
				textDocument: { uri: this.lsp.fileUri },
			});
		} catch {
			/* server down */
		}
	}

	async flush(): Promise<void> {
		this.cancelScheduledSave();
		// Never write over a disk change the user is still deciding about (C4).
		if (this.conflictOpen || !this.dirty) return;
		await this.anyView?.save();
	}

	/** Drop recovery/autosave state after an explicit “Don’t save” choice. */
	discardPendingChanges(): void {
		this.cancelScheduledSave();
		this.clearRecovery(this.path);
	}

	private recomputeDirty(): void {
		const next = this.currentText !== this.savedText;
		if (next === this.dirty) return;
		this.dirty = next;
		for (const view of this.views) view.refreshDirtyIndicator();
		this.onDirtyChange();
	}
}
