import { fileURLToPath } from "url";
import { realpathSync } from "fs";
import { Notice, TFile, type App } from "obsidian";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { LSPPlugin, Workspace } from "@codemirror/lsp-client";
import type { LSPClient, WorkspaceFile } from "@codemirror/lsp-client";
import {
	isNavigableCodeView,
	mirroredEdit,
	VIEW_TYPE_CODE,
} from "../editor/contracts";
import type { VaultMap } from "./roots";

interface WorkspaceHost {
	app: App;
	vaultMap: VaultMap | null;
}

/** Where `displayFile` should put a cross-file jump target. */
export type OpenMode = "replace" | "tab";

/** `WorkspaceFileUpdate` isn't exported by the package; recover it structurally. */
type FileUpdate = ReturnType<Workspace["syncFiles"]>[number];

/**
 * A file open in one or more Onyx panes. lsp-client's `DefaultWorkspace` tracks
 * exactly one editor per file; this tracks a set, so every split carries its own
 * `client.plugin(...)` (hover/completion/signature help per pane) while
 * didOpen/didChange/didClose stay coherent: one elected view is the sync and
 * diagnostics source, and `didClose` only fires when the last pane goes.
 */
class OnyxWorkspaceFile implements WorkspaceFile {
	readonly views = new Set<EditorView>();

	constructor(
		readonly uri: string,
		readonly languageId: string,
		public version: number,
		public doc: WorkspaceFile["doc"],
		initialView: EditorView,
	) {
		this.views.add(initialView);
	}

	/**
	 * The view lsp-client should treat as authoritative: the `main` hint when
	 * it's one of ours, otherwise the oldest still-open pane (stable until it
	 * closes).
	 */
	getView(main?: EditorView): EditorView | null {
		if (main && this.views.has(main)) return main;
		for (const view of this.views) return view;
		return null;
	}
}

function uriToPath(uri: string): string | null {
	try {
		return fileURLToPath(uri);
	} catch {
		return null;
	}
}

function canonicalUriPath(uri: string): string | null {
	const path = uriToPath(uri);
	if (!path) return null;
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * A `@codemirror/lsp-client` {@link Workspace} that supports multiple views per
 * file and resolves cross-file jumps (go-to-definition and friends) into real
 * Obsidian tabs.
 */
export class ObsidianWorkspace extends Workspace {
	files: WorkspaceFile[] = [];
	private readonly versions = new Map<string, number>();

	/** Consumed (and reset) by the next `displayFile` call. */
	pendingOpenMode: OpenMode = "replace";

	constructor(
		client: LSPClient,
		private readonly plugin: WorkspaceHost,
	) {
		super(client);
	}

	/**
	 * Servers may return a canonicalized or differently escaped file URI. Match
	 * those against the real filesystem path so notifications for symlinked and
	 * percent-encoded vault paths still reach their open editor.
	 */
	getFile(uri: string): WorkspaceFile | null {
		const exact = super.getFile(uri);
		if (exact) return exact;
		const target = canonicalUriPath(uri);
		if (!target) return null;
		return this.files.find((file) => canonicalUriPath(file.uri) === target) ?? null;
	}

	private nextVersion(uri: string): number {
		const next = (this.versions.get(uri) ?? -1) + 1;
		this.versions.set(uri, next);
		return next;
	}

	syncFiles(): readonly FileUpdate[] {
		const out: FileUpdate[] = [];
		for (const file of this.files as OnyxWorkspaceFile[]) {
			const source = file.getView();
			const sourcePlugin = source && LSPPlugin.get(source);
			if (!source || !sourcePlugin) continue;

			const changes = sourcePlugin.unsyncedChanges;

			// Peers mirror every edit, so their LSPPlugins hold the same pending
			// changes. Clear them unconditionally so a mirrored copy is never
			// re-sent (e.g. if a peer later becomes the elected source).
			for (const view of file.views) {
				if (view !== source) LSPPlugin.get(view)?.clear();
			}

			if (changes.empty) {
				sourcePlugin.clear();
				continue;
			}
			out.push({ file, changes, prevDoc: file.doc });
			file.doc = source.state.doc;
			file.version = this.nextVersion(file.uri);
			sourcePlugin.clear();
		}
		return out;
	}

	openFile(uri: string, languageId: string, view: EditorView): void {
		const existing = this.getFile(uri) as OnyxWorkspaceFile | null;
		if (existing) {
			existing.views.add(view);
			return; // already didOpen'd for this uri
		}
		const file = new OnyxWorkspaceFile(
			uri,
			languageId,
			this.nextVersion(uri),
			view.state.doc,
			view,
		);
		this.files.push(file);
		this.client.didOpen(file);
	}

	closeFile(uri: string, view: EditorView): void {
		const file = this.getFile(uri) as OnyxWorkspaceFile | null;
		if (!file || !file.views.has(view)) return;

		// Losing the elected source while peers remain: flush its pending edits
		// first so the successor starts from a synced baseline.
		if (file.views.size > 1 && file.getView() === view) {
			try {
				this.client.sync();
			} catch {
				/* not connected — nothing to flush */
			}
		}

		file.views.delete(view);
		if (file.views.size > 0) return; // other panes still hold it

		this.files = this.files.filter((f) => f !== file);
		this.client.didClose(uri);
	}

	/**
	 * Apply a server-authored edit (rename, format, code action) to every open
	 * pane. Marked as a mirrored edit so Onyx's own change-mirroring listener
	 * doesn't replay it a second time.
	 */
	updateFile(uri: string, update: TransactionSpec): void {
		const file = this.getFile(uri) as OnyxWorkspaceFile | null;
		if (!file) return;
		// Override annotations so Onyx's own mirroring listener ignores it;
		// callers (rename/format) don't pass their own annotations.
		const spec: TransactionSpec = {
			...update,
			annotations: mirroredEdit.of(true),
		};
		for (const view of file.views) view.dispatch(spec);
	}

	async displayFile(uri: string): Promise<EditorView | null> {
		const mode = this.pendingOpenMode;
		this.pendingOpenMode = "replace";

		const path = this.uriToVaultPath(uri);

		const alreadyOpen = this.findOpenView(path);
		if (alreadyOpen) return alreadyOpen;

		if (!path) {
			// stdlib / dependency header outside the vault — needs the external
			// read-only view (NOTES.md #5), not built yet.
			new Notice(
				`Onyx: definition is outside the vault\n${uriToPath(uri) ?? uri}`,
			);
			return null;
		}

		const tfile = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(tfile instanceof TFile)) {
			new Notice(`Onyx: could not open ${path}`);
			return null;
		}

		const leaf = this.plugin.app.workspace.getLeaf(
			mode === "tab" ? "tab" : false,
		);
		await leaf.openFile(tfile);
		return isNavigableCodeView(leaf.view) ? leaf.view.lspEditorView : null;
	}

	private findOpenView(vaultPath: string | null): EditorView | null {
		if (!vaultPath) return null;
		for (const leaf of this.plugin.app.workspace.getLeavesOfType(
			VIEW_TYPE_CODE,
		)) {
			const view = leaf.view;
			if (isNavigableCodeView(view) && view.file?.path === vaultPath) {
				this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
				return view.lspEditorView;
			}
		}
		return null;
	}

	/**
	 * `file://` URI -> vault-relative path, or null if it's outside the vault.
	 * Follows vault-level symlinks, so a definition in a repo linked into the
	 * vault resolves to its symlinked path rather than reading as "outside".
	 */
	private uriToVaultPath(uri: string): string | null {
		const abs = uriToPath(uri);
		if (!abs) return null;
		return this.plugin.vaultMap?.toVaultPath(abs) ?? null;
	}
}
