import {
	FileSystemAdapter,
	Notice,
	Plugin,
	sanitizeHTMLToDom,
	TAbstractFile,
	TFile,
	TextFileView,
	WorkspaceLeaf,
} from "obsidian";
import {
	Annotation,
	ChangeSet,
	Compartment,
	EditorState,
	Extension,
	Transaction,
} from "@codemirror/state";
import {
	EditorView,
	keymap,
	lineNumbers,
	highlightActiveLine,
	highlightActiveLineGutter,
	drawSelection,
	rectangularSelection,
	crosshairCursor,
} from "@codemirror/view";
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
} from "@codemirror/commands";
import {
	bracketMatching,
	indentOnInput,
	foldGutter,
	foldKeymap,
} from "@codemirror/language";
import {
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
} from "@codemirror/autocomplete";
import {
	Diagnostic,
	lintGutter,
	setDiagnostics,
	setDiagnosticsEffect,
} from "@codemirror/lint";
import {
	search,
	searchKeymap,
	highlightSelectionMatches,
} from "@codemirror/search";
import { jumpToDefinition, LSPPlugin } from "@codemirror/lsp-client";
import { realpathSync } from "fs";
import { resolve } from "path";
import { languageForExtension } from "./languages";
import { highlightDocCodeInto } from "./lsp/hover-highlight";
import { docHighlightStyle, editorStyle } from "./theme";
import { DocumentSession, LspBinding } from "./session";
import { ExternalChangeModal } from "./conflict";
import { languageIdForExtension } from "./lsp/ids";
import { resolveProject, VaultMap } from "./lsp/roots";
import { LspRegistry, ServerState } from "./lsp/registry";
import { ObsidianWorkspace, OpenMode } from "./lsp/workspace";
import { DEFAULT_SETTINGS, OnyxSettings, OnyxSettingTab } from "./settings";
import { NewSourceFileModal, parentPath } from "./new-file";
import { WORKSPACE_EXPLORER_VIEW, WorkspaceExplorerPane } from "./explorer";
import { stickyScroll } from "./sticky-scroll";
import { SYMBOLS_VIEW, SymbolsPane, type SymbolTarget } from "./symbols";
import { GitService, type GitFileStatus } from "./git";
import { gitGutter, setGitBaseline } from "./git-gutter";
import { RecoveryModal, type RecoverySnapshot } from "./recovery";

export const VIEW_TYPE_CODE = "onyx-code-view";

interface PluginData {
	version: 1;
	settings: OnyxSettings;
	buffers: Record<string, RecoverySnapshot>;
}

/**
 * Marks a transaction as a mirror of an edit (or a diagnostics set) that
 * originated in another view of the same file, so its update listener replays it
 * no further and doesn't re-trigger a save. Also consumed by the multi-view
 * `ObsidianWorkspace` for server-authored edits.
 */
export const mirroredEdit = Annotation.define<boolean>();

/**
 * Extensions Onyx claims from Obsidian's default text handling. `md` is
 * intentionally absent — Obsidian owns it and `registerExtensions` cannot
 * override it.
 */
const CODE_EXTENSIONS = [
	"js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
	"py", "pyi",
	"rs",
	"go",
	"c", "h", "cc", "cpp", "hpp", "cxx",
	"css", "scss", "less",
	"html", "htm", "xml",
	"json", "jsonc", "json5",
	"toml", "yaml", "yml", "ini", "cfg", "conf",
	"sh", "bash", "zsh", "fish",
	"sql",
	"lua", "rb", "php", "java", "kt", "swift", "zig",
	"nix",
	"dockerfile", "makefile",
	"env",
	"log", "txt",
];

export default class OnyxPlugin extends Plugin {
	settings: OnyxSettings = DEFAULT_SETTINGS;
	readonly sessions = new Map<string, DocumentSession>();
	lspRegistry!: LspRegistry;
	/** Real-path -> vault-path resolver; null for a non-filesystem vault. */
	vaultMap: VaultMap | null = null;
	private statusBar: HTMLElement | null = null;
	private lspStatusBar: HTMLElement | null = null;
	/** Latest lifecycle state per server key, for the status bar. */
	private serverStates = new Map<string, ServerState>();
	/** Server keys we've already shown a "no server" notice for. */
	private notifiedAbsent = new Set<string>();
	private lastCodeView: CodeView | null = null;
	private symbolsRefreshTimer: number | null = null;
	private git: GitService | null = null;
	private buffers: Record<string, RecoverySnapshot> = {};
	private recoveryTimers = new Map<string, number>();

	async onload() {
		await this.loadSettings();

		const vaultBase = this.resolveVaultBase();
		this.git = vaultBase ? new GitService() : null;
		this.vaultMap = vaultBase ? new VaultMap(vaultBase) : null;
		this.lspRegistry = new LspRegistry(
			() => this.settings.lspServers,
			(html, languageId) => {
				const host = createDiv();
				host.append(sanitizeHTMLToDom(html));
				highlightDocCodeInto(
					host,
					languageId,
					docHighlightStyle(this.settings),
				);
				return host.innerHTML;
			},
			this.vaultMap
				? (client) => new ObsidianWorkspace(client, this)
				: undefined,
		);

		this.register(
			this.lspRegistry.onChange((state) =>
				this.onServerStateChange(state),
			),
		);

		this.registerView(VIEW_TYPE_CODE, (leaf) => new CodeView(leaf, this));
		this.registerView(
			WORKSPACE_EXPLORER_VIEW,
			(leaf) => new WorkspaceExplorerPane(leaf, {
				newFile: (folder) => this.openNewSourceFileModal(folder),
				gitStatus: (root) => this.gitStatusForExplorer(root),
				isDirty: (path) => this.sessions.get(path)?.dirty ?? false,
			}),
		);
		this.registerView(
			SYMBOLS_VIEW,
			(leaf) => new SymbolsPane(leaf, { getTarget: () => this.symbolTarget() }),
		);
		this.claimExtensions();
		this.registerFileCommands();
		this.registerLspCommands();
		this.addSettingTab(new OnyxSettingTab(this.app, this));

		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("onyx-status");
		this.lspStatusBar = this.addStatusBarItem();
		this.lspStatusBar.addClass("onyx-lsp-status");
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof CodeView) this.lastCodeView = leaf.view;
				this.updateStatusBar();
				this.updateLspStatusBar();
				if (leaf?.view instanceof CodeView) leaf.view.refreshGitBaseline();
				this.refreshSymbols();
			}),
		);
		this.updateStatusBar();
		this.updateLspStatusBar();
	}

	private symbolTarget(): SymbolTarget | null {
		const view = this.app.workspace.getActiveViewOfType(CodeView) ?? this.lastCodeView;
		const editor = view?.lspEditorView ?? null;
		return editor && view?.file
			? { editor, fileName: view.file.name }
			: null;
	}

	refreshSymbols(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SYMBOLS_VIEW)) {
			if (leaf.view instanceof SymbolsPane) void leaf.view.refresh();
		}
	}

	scheduleSymbolsRefresh(): void {
		if (this.symbolsRefreshTimer !== null) {
			window.clearTimeout(this.symbolsRefreshTimer);
		}
		this.symbolsRefreshTimer = window.setTimeout(() => {
			this.symbolsRefreshTimer = null;
			this.refreshSymbols();
		}, 250);
	}


	private registerFileCommands(): void {
		const open = () => this.openNewSourceFileModal();
		this.addCommand({
			id: "new-source-file",
			name: "Create new source file",
			callback: open,
		});
		this.addCommand({
			id: "open-workspace-explorer",
			name: "Open workspace explorer",
			callback: () => void this.openWorkspaceExplorer(),
		});
		this.addCommand({
			id: "open-symbols",
			name: "Open symbols",
			callback: () => void this.openSymbols(),
		});
		this.addRibbonIcon("file-plus", "Create new source file", open);
		this.addRibbonIcon("folder-tree", "Open workspace explorer", () =>
			void this.openWorkspaceExplorer(),
		);
	}

	private async openSymbols(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(SYMBOLS_VIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
			await leaf.setViewState({ type: SYMBOLS_VIEW, active: true });
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		if (leaf.view instanceof SymbolsPane) void leaf.view.refresh();
	}

	private openNewSourceFileModal(baseFolder?: string): void {
		const folder = baseFolder ?? parentPath(this.app.workspace.getActiveFile()?.path);
		const initial = folder ? `${folder}/untitled.ts` : "untitled.ts";
		new NewSourceFileModal(this.app, initial, (path) =>
			this.createSourceFile(path),
		).open();
	}

	private async openWorkspaceExplorer(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(WORKSPACE_EXPLORER_VIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeftLeaf(false) ?? this.app.workspace.getLeaf("tab");
			const rootPath = parentPath(this.app.workspace.getActiveFile()?.path);
			await leaf.setViewState({
				type: WORKSPACE_EXPLORER_VIEW,
				active: true,
				state: { rootPath },
			});
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	private async createSourceFile(path: string): Promise<TFile> {
		if (this.app.vault.getAbstractFileByPath(path)) {
			throw new Error(`A file already exists at “${path}”.`);
		}

		const parts = path.split("/");
		parts.pop();
		let folder = "";
		for (const part of parts) {
			folder = folder ? `${folder}/${part}` : part;
			const existing: TAbstractFile | null =
				this.app.vault.getAbstractFileByPath(folder);
			if (!existing) await this.app.vault.createFolder(folder);
			else if (existing instanceof TFile) {
				throw new Error(`“${folder}” is a file, not a folder.`);
			}
		}

		const file = await this.app.vault.create(path, "");
		await this.app.workspace.getLeaf(false).openFile(file);
		return file;
	}

	onunload() {
		if (this.symbolsRefreshTimer !== null) {
			window.clearTimeout(this.symbolsRefreshTimer);
		}
		for (const timer of this.recoveryTimers.values()) window.clearTimeout(timer);
		this.recoveryTimers.clear();
		for (const session of this.sessions.values()) session.saveNow();
		this.sessions.clear();
		this.lspRegistry.disposeAll();
	}

	/**
	 * Register one extension at a time. `registerExtensions` throws for the
	 * entire batch if any single extension is already owned (by core — e.g.
	 * `svg` — or another plugin), so a per-extension loop lets the rest through
	 * and reports what it had to skip.
	 */
	private claimExtensions() {
		const skipped: string[] = [];
		for (const ext of CODE_EXTENSIONS) {
			try {
				this.registerExtensions([ext], VIEW_TYPE_CODE);
			} catch {
				skipped.push(ext);
			}
		}
		if (skipped.length > 0) {
			console.warn(
				`Onyx: these extensions are already registered elsewhere and were skipped: ${skipped.join(", ")}`,
			);
		}
	}

	getOrCreateSession(path: string, initialText: string): DocumentSession {
		let session = this.sessions.get(path);
		if (!session) {
			session = new DocumentSession(
				path,
				initialText,
				() => this.settings.savePolicy,
				() => this.updateStatusBar(),
				this.lspBindingFor(path),
				() => this.settings.autoSaveDelayMs,
				(p, resolve) =>
					new ExternalChangeModal(
						this.app,
						p.split("/").pop() ?? p,
						resolve,
					).open(),
				(path, text, diskText) => this.scheduleRecovery(path, text, diskText),
				(path) => this.clearRecovery(path),
			);
			this.sessions.set(path, session);
		}
		return session;
	}

	/**
	 * Resolve a vault path to the language-server binding for its session, or
	 * `null` when LSP is off, the file isn't on a real filesystem, we don't map
	 * its extension to a language id, or its on-disk path can't be resolved.
	 */
	private lspBindingFor(path: string): LspBinding | null {
		if (!this.settings.lspEnabled) return null;
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;

		const languageId = languageIdForExtension(path.split(".").pop());
		if (!languageId) return null;

		const proj = resolveProject(adapter.getFullPath(path));
		if (!proj) return null;

		return {
			fileUri: proj.fileUri,
			languageId,
			realRoot: proj.realRoot,
			acquire: () =>
				this.lspRegistry.acquire(
					proj.realRoot,
					proj.rootUri,
					languageId,
				),
			current: () =>
				this.lspRegistry.clientFor(proj.realRoot, languageId),
			release: () =>
				this.lspRegistry.release(proj.realRoot, languageId),
		};
	}

	releaseSession(path: string): void {
		const session = this.sessions.get(path);
		if (session && session.size === 0) this.sessions.delete(path);
	}

	/** `realpathSync` of the vault root, or `null` for a non-filesystem vault. */
	private resolveVaultBase(): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		const base = adapter.getBasePath();
		try {
			return realpathSync(base);
		} catch {
			return base;
		}
	}

	/**
	 * Run go-to-definition for `view`, routing the target through `mode` (reuse
	 * the current tab, or open a new one). Returns false when the view has no
	 * language server attached.
	 */
	lspGoToDefinition(view: EditorView, mode: OpenMode): boolean {
		const workspace = LSPPlugin.get(view)?.client.workspace;
		if (workspace instanceof ObsidianWorkspace) {
			workspace.pendingOpenMode = mode;
		}
		return jumpToDefinition(view);
	}

	private registerLspCommands(): void {
		const run = (mode: OpenMode) => (checking: boolean): boolean => {
			const view = this.app.workspace.getActiveViewOfType(CodeView);
			const editor = view?.lspEditorView ?? null;
			if (!editor || !LSPPlugin.get(editor)) return false;
			if (!checking) this.lspGoToDefinition(editor, mode);
			return true;
		};
		this.addCommand({
			id: "goto-definition",
			name: "Go to definition",
			checkCallback: run("replace"),
		});
		this.addCommand({
			id: "goto-definition-new-tab",
			name: "Go to definition in new tab",
			checkCallback: run("tab"),
		});
		this.addCommand({
			id: "restart-language-server",
			name: "Restart language server",
			checkCallback: (checking: boolean): boolean => {
				const view = this.app.workspace.getActiveViewOfType(CodeView);
				const target = view?.file
					? this.sessions.get(view.file.path)?.lspTarget
					: undefined;
				if (!target) return false;
				if (!checking) {
					// Let a still-missing server notify again after a manual retry.
					this.notifiedAbsent.delete(
						LspRegistry.keyFor(
							target.realRoot,
							target.languageId,
						),
					);
					this.lspRegistry.restart(
						target.realRoot,
						target.languageId,
					);
				}
				return true;
			},
		});
	}

	/**
	 * React to a server lifecycle change: tell the user once when a server is
	 * missing or has crashed, and re-bind open sessions when one comes up.
	 */
	private onServerStateChange(state: ServerState): void {
		this.serverStates.set(state.key, state);

		if (state.status === "absent") {
			if (!this.notifiedAbsent.has(state.key)) {
				this.notifiedAbsent.add(state.key);
				new Notice(
					`Onyx: ${state.detail ?? `no language server for ${state.languageId}`}`,
				);
			}
		} else if (state.status === "crashed") {
			new Notice(`Onyx: ${state.languageId} language server — ${state.detail ?? "crashed"}`);
		} else if (state.status === "running") {
			this.notifiedAbsent.delete(state.key);
			for (const session of this.sessions.values()) {
				if (session.usesServer(state.realRoot, state.languageId)) {
					session.resyncLsp();
				}
			}
		}

		this.updateLspStatusBar();
	}

	updateLspStatusBar(): void {
		if (!this.lspStatusBar) return;
		const view = this.app.workspace.getActiveViewOfType(CodeView);
		const target = view?.file
			? this.sessions.get(view.file.path)?.lspTarget
			: undefined;
		const state = target
			? this.serverStates.get(
					LspRegistry.keyFor(target.realRoot, target.languageId),
				)
			: undefined;

		let text = "";
		if (state?.status === "starting") text = "◌ LSP starting";
		else if (state?.status === "crashed") text = "⚠ LSP crashed";
		this.lspStatusBar.setText(text);
		this.lspStatusBar.toggleClass(
			"mod-warning",
			state?.status === "crashed",
		);
	}

	applyStyleToOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CODE)) {
			if (leaf.view instanceof CodeView) leaf.view.applyStyleSettings();
		}
	}

	updateStatusBar(): void {
		if (!this.statusBar) return;
		const view = this.app.workspace.getActiveViewOfType(CodeView);
		const session = view && view.file
			? this.sessions.get(view.file.path)
			: undefined;
		this.statusBar.setText(session?.dirty ? "● Unsaved" : "");
		for (const leaf of this.app.workspace.getLeavesOfType(WORKSPACE_EXPLORER_VIEW)) {
			if (leaf.view instanceof WorkspaceExplorerPane) void leaf.view.refresh();
		}
	}

	async loadSettings() {
		const raw = await this.loadData() as Partial<OnyxSettings> | Partial<PluginData> | null;
		const data: Partial<PluginData> | null = raw && "settings" in raw ? raw : null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? raw);
		this.buffers = data?.buffers ?? {};
	}

	async saveSettings() {
		await this.savePluginData();
	}

	private async savePluginData(): Promise<void> {
		await this.saveData({ version: 1, settings: this.settings, buffers: this.buffers } satisfies PluginData);
	}

	private scheduleRecovery(path: string, text: string, diskText: string): void {
		const old = this.recoveryTimers.get(path);
		if (old !== undefined) window.clearTimeout(old);
		this.recoveryTimers.set(path, window.setTimeout(() => {
			this.recoveryTimers.delete(path);
			// Avoid turning plugin data into an unbounded shadow filesystem.
			if (text.length <= 5 * 1024 * 1024) {
				this.buffers[path] = { text, diskText, updatedAt: Date.now() };
				void this.savePluginData();
			}
		}, 500));
	}

	private clearRecovery(path: string): void {
		const timer = this.recoveryTimers.get(path);
		if (timer !== undefined) window.clearTimeout(timer);
		this.recoveryTimers.delete(path);
		if (!(path in this.buffers)) return;
		delete this.buffers[path];
		void this.savePluginData();
	}

	async recoverText(path: string, diskText: string): Promise<string> {
		const snapshot = this.buffers[path];
		if (!snapshot || snapshot.text === diskText) {
			if (snapshot) this.clearRecovery(path);
			return diskText;
		}
		return new Promise((resolveText) => new RecoveryModal(
			this.app,
			path.split("/").pop() ?? path,
			snapshot.diskText !== diskText,
			(choice) => {
				if (choice === "disk") this.clearRecovery(path);
				resolveText(choice === "restore" ? snapshot.text : diskText);
			},
		).open());
	}

	async gitHeadText(path: string): Promise<string | null> {
		const adapter = this.app.vault.adapter;
		return this.git && adapter instanceof FileSystemAdapter
			? this.git.headText(adapter.getFullPath(path)) : null;
	}

	private async gitStatusForExplorer(rootPath: string): Promise<Map<string, GitFileStatus>> {
		const adapter = this.app.vault.adapter;
		if (!this.git || !(adapter instanceof FileSystemAdapter)) return new Map();
		const result = await this.git.statusFor(resolve(adapter.getFullPath(rootPath), ".onyx-status-anchor"));
		if (!result || !this.vaultMap) return new Map();
		const statuses = new Map<string, GitFileStatus>();
		for (const [repoPath, status] of result.files) {
			const vaultPath = this.vaultMap.toVaultPath(resolve(result.root, repoPath));
			if (vaultPath) statuses.set(vaultPath, status);
		}
		return statuses;
	}
}

export class CodeView extends TextFileView {
	private editor: EditorView | null = null;
	private session: DocumentSession | null = null;
	private readonly styleCompartment = new Compartment();
	private readonly lspCompartment = new Compartment();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: OnyxPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CODE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Code";
	}

	getIcon(): string {
		return "code";
	}

	// --- content bridge ---------------------------------------------------

	/** Called by Obsidian's save pipeline to get bytes to write. */
	getViewData(): string {
		return this.getEditorText();
	}

	getEditorText(): string {
		return this.editor ? this.editor.state.doc.toString() : this.data;
	}

	/** Called by Obsidian on file load (clear) and on external change (!clear). */
	setViewData(data: string, clear: boolean): void {
		this.data = data;
		if (!this.editor) return;

		if (clear) {
			this.editor.setState(this.buildState(data));
		} else if (this.session) {
			this.session.handleExternalChange(data);
			this.refreshGitBaseline();
		} else {
			this.setEditorText(data, false);
		}
	}

	setEditorText(text: string, resetHistory: boolean): void {
		this.data = text;
		if (!this.editor) return;
		if (resetHistory) {
			this.editor.setState(this.buildState(text));
		} else {
			this.editor.dispatch({
				changes: {
					from: 0,
					to: this.editor.state.doc.length,
					insert: text,
				},
				annotations: [
					mirroredEdit.of(true),
					Transaction.addToHistory.of(false),
				],
			});
		}
	}

	/**
	 * Replay an edit made in a peer view. `addToHistory: false` keeps it out of
	 * this view's undo stack, so each pane only undoes its own typing (C6);
	 * content stays in sync because every edit is always mirrored.
	 */
	applyMirroredChanges(changes: ChangeSet): void {
		this.editor?.dispatch({
			changes,
			annotations: [
				mirroredEdit.of(true),
				Transaction.addToHistory.of(false),
			],
		});
	}

	/** Replay a diagnostics set published to the workspace's elected peer view. */
	applyMirroredDiagnostics(diagnostics: readonly Diagnostic[]): void {
		if (!this.editor) return;
		this.editor.dispatch({
			...setDiagnostics(this.editor.state, diagnostics),
			annotations: mirroredEdit.of(true),
		});
	}

	/**
	 * Swap the language-server plugin for this view. Called by the session for
	 * every attached view — the multi-view workspace reference-counts
	 * didOpen/didClose and elects one view as the sync/diagnostics source.
	 */
	setLspExtension(extension: Extension): void {
		this.editor?.dispatch({
			effects: this.lspCompartment.reconfigure(extension),
		});
	}

	/** The live editor, for the LSP workspace to target on a cross-file jump. */
	get lspEditorView(): EditorView | null {
		return this.editor;
	}

	refreshGitBaseline(): void {
		const path = this.file?.path;
		if (!path) return;
		void this.plugin.gitHeadText(path).then((baseline) => {
			if (this.file?.path === path && this.editor) {
				this.editor.dispatch({ effects: setGitBaseline.of(baseline) });
			}
		});
	}

	clear(): void {
		this.data = "";
		this.editor?.setState(this.buildState(""));
	}

	// --- lifecycle ------------------------------------------------------------

	async onOpen(): Promise<void> {
		this.contentEl.addClass("onyx-code-view");
		this.applyFontVars();
		this.editor = new EditorView({
			state: this.buildState(this.data ?? ""),
			parent: this.contentEl,
		});
	}

	async onClose(): Promise<void> {
		// Obsidian usually runs onUnloadFile before onClose on leaf close, but
		// it isn't guaranteed. Tear the session down here too; detach() and
		// releaseSession() are both idempotent, so the normal double call is a
		// no-op and a missed onUnloadFile no longer leaks a session + server.
		if (this.session && this.file) {
			try {
				await this.session.flush();
			} catch {
				/* best effort while the leaf is going away */
			}
			this.session.detach(this);
			this.plugin.releaseSession(this.file.path);
			this.session = null;
		}
		this.editor?.destroy();
		this.editor = null;
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		const diskText = this.data;

		const preexisting = this.plugin.sessions.get(file.path);
		const joiningPeers = !!preexisting && preexisting.size > 0;

		// Adopt peers' live (possibly unsaved) buffer *before* wiring up LSP:
		// this is a full setState, and doing it after attach() would tear down
		// the LSP plugin attach() just added.
		if (joiningPeers && preexisting) {
			this.setEditorText(preexisting.currentText, true);
		} else {
			this.setEditorText(await this.plugin.recoverText(file.path, diskText), true);
		}

		this.session = this.plugin.getOrCreateSession(file.path, diskText);
		this.session.attach(this);
		this.refreshGitBaseline();

		this.refreshDirtyIndicator();
	}

	async onUnloadFile(file: TFile): Promise<void> {
		if (this.session) {
			await this.session.flush();
			this.session.detach(this);
			this.plugin.releaseSession(file.path);
			this.session = null;
		}
		await super.onUnloadFile(file);
	}

	async save(clear?: boolean): Promise<void> {
		await super.save(clear);
		this.session?.markSaved();
	}

	refreshDirtyIndicator(): void {
		this.plugin.updateStatusBar();
	}

	/** Re-apply appearance settings to a live editor (called on settings change). */
	applyStyleSettings(): void {
		this.applyFontVars();
		this.editor?.dispatch({
			effects: this.styleCompartment.reconfigure(
				this.styleExtensions(),
			),
		});
	}

	private applyFontVars(): void {
		const s = this.plugin.settings;
		const el = this.contentEl;
		el.style.setProperty(
			"--onyx-font-family",
			s.fontFamily || "var(--font-monospace)",
		);
		el.style.setProperty(
			"--onyx-font-size",
			s.fontSize > 0 ? `${s.fontSize}px` : "var(--font-text-size)",
		);
		el.style.setProperty(
			"--onyx-line-height",
			String(s.lineHeight > 0 ? s.lineHeight : 1.5),
		);
		el.style.setProperty(
			"--onyx-font-features",
			s.ligatures ? '"calt", "liga"' : '"calt" 0, "liga" 0',
		);
	}

	// --- editor construction -----------------------------------------------

	private buildState(doc: string): EditorState {
		// this.file is set by TextFileView.onLoadFile before setViewData runs, so
		// the extension is known here on load and on every file switch in the leaf.
		const language = languageForExtension(this.file?.extension);
		return EditorState.create({
			doc,
			extensions: [
				...this.baseExtensions(),
				...(language ? [language] : []),
			],
		});
	}

	private stickyLanguageId(): string | null {
		return languageIdForExtension(this.file?.extension);
	}

	private styleExtensions(): Extension[] {
		return [
			...editorStyle(this.plugin.settings),
			...(this.plugin.settings.stickyScroll
				? [stickyScroll(this.stickyLanguageId())]
				: []),
		];
	}

	private baseExtensions(): Extension[] {
		return [
			this.styleCompartment.of(this.styleExtensions()),
			lineNumbers(),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			foldGutter(),
			gitGutter(),
			drawSelection(),
			rectangularSelection(),
			crosshairCursor(),
			history(),
			indentOnInput(),
			bracketMatching(),
			closeBrackets(),
			autocompletion(),
			lintGutter(),
			highlightSelectionMatches(),
			search({ top: true }),
			// Populated by the session with client.plugin(...) for every view.
			this.lspCompartment.of([]),
			keymap.of([
				{
					key: "Mod-s",
					preventDefault: true,
					run: () => {
						this.session?.saveNow();
						return true;
					},
				},
				...closeBracketsKeymap,
				...completionKeymap,
				...defaultKeymap,
				...historyKeymap,
				...foldKeymap,
				...searchKeymap,
				indentWithTab,
			]),
			EditorView.updateListener.of((update) => {
				// Server-published diagnostics land on the workspace's elected
				// view only — mirror them so every pane shows the underlines.
				for (const tr of update.transactions) {
					if (tr.annotation(mirroredEdit)) continue;
					for (const effect of tr.effects) {
						if (effect.is(setDiagnosticsEffect)) {
							this.session?.mirrorDiagnostics(
								this,
								effect.value,
							);
						}
					}
				}

					if (!update.docChanged) return;
					this.plugin.scheduleSymbolsRefresh();
					this.data = update.state.doc.toString();

				const mirrored = update.transactions.some((tr) =>
					tr.annotation(mirroredEdit),
				);
				if (mirrored) return;

				this.session?.handleLocalChange(this, update.changes);
			}),
			EditorView.domEventHandlers({
				blur: () => this.session?.notifyBlur(),
				mousedown: (event, view) => {
					// Cmd/Ctrl-click: go to definition in a new tab, matching
					// Obsidian's link convention. Add Alt to open it in place.
					if (event.button !== 0) return false;
					if (!(event.metaKey || event.ctrlKey)) return false;
					if (!LSPPlugin.get(view)) return false;
					const pos = view.posAtCoords({
						x: event.clientX,
						y: event.clientY,
					});
					if (pos == null) return false;
					event.preventDefault();
					view.dispatch({ selection: { anchor: pos } });
					this.plugin.lspGoToDefinition(
						view,
						event.altKey ? "replace" : "tab",
					);
					return true;
				},
			}),
		];
	}
}
