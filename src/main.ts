import {
	FileSystemAdapter,
	Notice,
	Plugin,
	sanitizeHTMLToDom,
	TAbstractFile,
	TFile,
	TextFileView,
	WorkspaceLeaf,
	type OpenViewState,
} from "obsidian";
import {
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
	indentUnit,
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
	forEachDiagnostic,
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
import { resolveLspSetup, type LspSetup } from "./lsp/setup";
import { LspTrustModal } from "./lsp/trust";
import { LspRegistry, ServerState } from "./lsp/registry";
import { ObsidianWorkspace, OpenMode } from "./lsp/workspace";
import { DEFAULT_SETTINGS, OnyxSettings, OnyxSettingTab } from "./settings";
import { NewSourceFileModal, parentPath } from "./new-file";
import {
	WORKSPACE_EXPLORER_VIEW,
	WorkspaceExplorerPane,
	workspaceRootForPath,
	workspaceRootPaths,
} from "./explorer";
import { stickyScroll } from "./sticky-scroll";
import { SYMBOLS_VIEW, SymbolsPane, type SymbolTarget } from "./symbols";
import { currentFunction, scopeChain } from "./outline";
import { GitService, type GitFileStatus } from "./git";
import { gitGutter, setGitBaseline } from "./git-gutter";
import { RecoveryModal, type RecoverySnapshot } from "./recovery";
import { DirtyCloseModal } from "./close-confirm";
import { startLint, type LintIssue } from "./lint";
import type { ChildProcess } from "child_process";
import { dirname } from "path";
import { mirroredEdit, VIEW_TYPE_CODE } from "./editor/contracts";

export { mirroredEdit, VIEW_TYPE_CODE } from "./editor/contracts";

interface PluginData {
	version: 1;
	settings: OnyxSettings;
	buffers: Record<string, RecoverySnapshot>;
	trustedProjects: Record<string, string>;
}

/**
 * Marks a transaction as a mirror of an edit (or a diagnostics set) that
 * originated in another view of the same file, so its update listener replays it
 * no further and doesn't re-trigger a save. Also consumed by the multi-view
 * `ObsidianWorkspace` for server-authored edits.
 */
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
	private lintTimers = new Map<string, number>();
	private lintProcesses = new Map<string, ChildProcess>();
	private trustedProjects: Record<string, string> = {};

	async onload() {
		await this.loadSettings();

		const vaultBase = this.resolveVaultBase();
		this.git = vaultBase ? new GitService() : null;
		this.vaultMap = vaultBase
			? new VaultMap(vaultBase, this.settings.externalSymlinksEnabled)
			: null;
		this.lspRegistry = new LspRegistry(
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
				openFile: (file, newLeaf) => this.openWorkspaceFile(file, newLeaf),
				gitStatus: (root) => this.gitStatusForExplorer(root),
				isDirty: (path) => this.sessions.get(path)?.dirty ?? false,
				workspacePaths: () => this.settings.workspacePaths,
				addWorkspace: (path) => this.addWorkspace(path),
			}),
		);
		this.registerView(
			SYMBOLS_VIEW,
			(leaf) => new SymbolsPane(leaf, { getTarget: () => this.symbolTarget() }),
		);
		this.claimExtensions();
		this.registerFileCommands();
		this.registerLintCommands();
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
			? {
				editor,
				fileName: view.file.name,
				languageId: languageIdForExtension(view.file.extension),
			}
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
			name: "Open function outline",
			callback: () => void this.openSymbols(),
		});
		this.addRibbonIcon("file-plus", "Create new source file", open);
		this.addRibbonIcon("folder-tree", "Open workspace explorer", () =>
			void this.openWorkspaceExplorer(),
		);
	}

	private registerLintCommands(): void {
		this.addCommand({
			id: "lint-current-file",
			name: "Lint current file",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(CodeView);
				if (!view?.file || !this.lintCommandFor(view.file)) return false;
				if (!checking) void this.lintView(view, true);
				return true;
			},
		});
	}

	private lintCommandFor(file: TFile): string[] | null {
		return this.settings.lintCommands[file.name]
			?? this.settings.lintCommands[file.extension.toLowerCase()]
			?? this.settings.lintCommands[`.${file.extension.toLowerCase()}`]
			?? null;
	}

	scheduleLint(view: CodeView): void {
		if (this.settings.lintTrigger !== "afterDelay" || !view.file) return;
		const path = view.file.path;
		this.lintProcesses.get(path)?.kill();
		this.lintProcesses.delete(path);
		const old = this.lintTimers.get(path);
		if (old !== undefined) window.clearTimeout(old);
		this.lintTimers.set(path, window.setTimeout(() => {
			this.lintTimers.delete(path);
			void this.lintView(view, false);
		}, Math.max(250, this.settings.lintDelayMs)));
	}

	async lintView(view: CodeView, showNotices: boolean): Promise<void> {
		const file = view.file;
		if (!file) return;
		const command = this.lintCommandFor(file);
		if (!command) {
			if (showNotices) new Notice(`No lint command configured for ${file.name}.`);
			return;
		}
		try {
			if (this.sessions.get(file.path)?.dirty) await view.save();
		} catch {
			if (showNotices) new Notice("Could not save the file before linting.");
			return;
		}
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			if (showNotices) new Notice("External lint commands require a desktop filesystem vault.");
			return;
		}
		this.lintProcesses.get(file.path)?.kill();
		const fullPath = adapter.getFullPath(file.path);
		const workspace = resolveProject(fullPath)?.realRoot ?? dirname(fullPath);
		const process = startLint(command, fullPath, workspace, (error, issues) => {
			if (this.lintProcesses.get(file.path) !== process) return;
			this.lintProcesses.delete(file.path);
			if (error) {
				if (showNotices) new Notice(`Could not run linter: ${error.message}`);
				return;
			}
			view.showLintIssues(issues);
			if (showNotices) new Notice(issues.length === 0 ? "No lint issues found." : `${issues.length} lint issue${issues.length === 1 ? "" : "s"}.`);
		});
		if (process) this.lintProcesses.set(file.path, process);
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
			const rootPath = workspaceRootForPath(
				this.app.workspace.getActiveFile()?.path,
				this.settings.workspacePaths,
			);
			await leaf.setViewState({
				type: WORKSPACE_EXPLORER_VIEW,
				active: true,
				state: { rootPath },
			});
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	private async addWorkspace(path: string): Promise<void> {
		if (!workspaceRootPaths(this.app.vault.getFiles()).includes(path)) {
			throw new Error("A workspace must contain a top-level onyx.toml.");
		}
		if (this.settings.workspacePaths.includes(path)) return;
		this.settings.workspacePaths = [...this.settings.workspacePaths, path];
		await this.saveSettings();
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

	/** Open explorer files in an editor leaf, independent of sidebar focus timing. */
	private async openWorkspaceFile(file: TFile, newLeaf: boolean): Promise<void> {
		const codeLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODE);
		const activeView = this.app.workspace.getActiveViewOfType(CodeView);
		// getLeaf(false) preserves Obsidian's current navigable target. In
		// particular, it returns a selected empty "New tab", which should be
		// consumed before we fall back to an existing Onyx editor.
		const navigableLeaf = this.app.workspace.getLeaf(false);
		const leaf = newLeaf
			? this.app.workspace.getLeaf("tab")
			: navigableLeaf.view.getViewType() === "empty"
				? navigableLeaf
				: codeLeaves.find((candidate) => candidate.view === activeView)
				?? codeLeaves.find((candidate) => candidate.view === this.lastCodeView)
				?? codeLeaves[0]
				?? navigableLeaf;
		if (this.app.vault.getAbstractFileByPath(file.path) instanceof TFile) {
			await leaf.openFile(file);
		} else {
			// Hidden dotfiles discovered through DataAdapter have no entry for
			// WorkspaceLeaf.openFile to resolve. Mount the same CodeView directly
			// and let TextFileView load the adapter-backed TFile bridge.
			const view = new CodeView(leaf, this);
			await leaf.open(view);
			await view.onLoadFile(file);
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	onunload() {
		if (this.symbolsRefreshTimer !== null) {
			window.clearTimeout(this.symbolsRefreshTimer);
		}
		for (const timer of this.recoveryTimers.values()) window.clearTimeout(timer);
		this.recoveryTimers.clear();
		for (const timer of this.lintTimers.values()) window.clearTimeout(timer);
		this.lintTimers.clear();
		for (const process of this.lintProcesses.values()) process.kill();
		this.lintProcesses.clear();
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

		const proj = resolveLspSetup(adapter.getFullPath(path), languageId);
		if (!proj) return null;

		return {
			fileUri: proj.fileUri,
			languageId,
			realRoot: proj.realRoot,
			acquire: () =>
				this.trustedProjects[proj.configPath] === proj.fingerprint
					? this.lspRegistry.acquire(
					proj.realRoot,
					proj.rootUri,
					languageId,
					proj.command,
					)
					: null,
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
		this.addCommand({
			id: "trust-current-project-lsp",
			name: "Trust current project's language server",
			checkCallback: (checking): boolean => {
				const setup = this.currentLspSetup();
				if (!setup || this.trustedProjects[setup.configPath] === setup.fingerprint) return false;
				if (!checking) new LspTrustModal(this.app, setup, () => {
					this.trustedProjects[setup.configPath] = setup.fingerprint;
					void this.savePluginData();
					const view = this.app.workspace.getActiveViewOfType(CodeView);
					if (view?.file) {
						this.sessions.get(view.file.path)?.replaceLspBinding(
							this.lspBindingFor(view.file.path),
						);
					}
				}).open();
				return true;
			},
		});
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

	private currentLspSetup(): LspSetup | null {
		const file = this.app.workspace.getActiveViewOfType(CodeView)?.file;
		const adapter = this.app.vault.adapter;
		if (!file || !(adapter instanceof FileSystemAdapter)) return null;
		const languageId = languageIdForExtension(file.extension);
		return languageId ? resolveLspSetup(adapter.getFullPath(file.path), languageId) : null;
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
		if (!view?.file) {
			this.lspStatusBar.setText("");
			this.lspStatusBar.removeClass("mod-warning");
			return;
		}
		if (!this.settings.lspEnabled) {
			this.lspStatusBar.setText("Language server off");
			this.lspStatusBar.removeClass("mod-warning");
			return;
		}
		const setup = this.currentLspSetup();
		if (setup && this.trustedProjects[setup.configPath] !== setup.fingerprint) {
			this.lspStatusBar.setText(`LSP ${setup.languageId}: trust required`);
			this.lspStatusBar.addClass("mod-warning");
			return;
		}
		const target = view?.file
			? this.sessions.get(view.file.path)?.lspTarget
			: undefined;
		if (!target) {
			const languageId = languageIdForExtension(view.file.extension);
			this.lspStatusBar.setText(languageId ? "LSP unavailable" : "LSP unsupported");
			this.lspStatusBar.toggleClass("mod-warning", !!languageId);
			return;
		}
		const state = target
			? this.serverStates.get(
					LspRegistry.keyFor(target.realRoot, target.languageId),
				)
			: undefined;

		let text: string;
		if (state?.status === "starting") text = `◌ LSP ${target.languageId}: starting`;
		else if (state?.status === "crashed") text = `⚠ LSP ${target.languageId}: crashed`;
		else if (state?.status === "absent") text = `⚠ LSP ${target.languageId}: unavailable`;
		else if (state?.status === "running") {
			let errors = 0;
			let warnings = 0;
			let other = 0;
			const editor = view.lspEditorView;
			if (editor) {
				forEachDiagnostic(editor.state, (diagnostic) => {
					if (diagnostic.severity === "error") errors++;
					else if (diagnostic.severity === "warning") warnings++;
					else other++;
				});
			}
			const counts = [
				errors ? `${errors} error${errors === 1 ? "" : "s"}` : "",
				warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
				other ? `${other} info` : "",
			].filter(Boolean).join(", ");
			text = `LSP ${target.languageId}: ${counts || "ready"}`;
		} else {
			text = `LSP ${target.languageId}: connecting`;
		}
		this.lspStatusBar.setText(text);
		this.lspStatusBar.toggleClass(
			"mod-warning",
			state?.status === "crashed" || state?.status === "absent",
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
		this.trustedProjects = data?.trustedProjects ?? {};
	}

	async saveSettings() {
		await this.savePluginData();
	}

	applyIntegrationSettings(): void {
		this.vaultMap?.setExternalLinksEnabled(this.settings.externalSymlinksEnabled);
		this.updateStatusBar();
	}

	private async savePluginData(): Promise<void> {
		await this.saveData({ version: 1, settings: this.settings, buffers: this.buffers, trustedProjects: this.trustedProjects } satisfies PluginData);
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
		return this.settings.gitEnabled && this.git && adapter instanceof FileSystemAdapter
			? this.git.headText(adapter.getFullPath(path)) : null;
	}

	private async gitStatusForExplorer(rootPath: string): Promise<Map<string, GitFileStatus>> {
		const adapter = this.app.vault.adapter;
		if (!this.settings.gitEnabled || !this.git || !(adapter instanceof FileSystemAdapter)) return new Map();
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
	private originalLeafDetach: (() => void) | null = null;
	private originalLeafOpenFile: ((file: TFile, openState?: OpenViewState) => Promise<void>) | null = null;
	private closeApproved = false;
	private closePromptOpen = false;
	private discardOnClose = false;
	private tabHeaderEl: HTMLElement | null = null;

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

	showLintIssues(issues: readonly LintIssue[]): void {
		if (!this.editor) return;
		const doc = this.editor.state.doc;
		const diagnostics: Diagnostic[] = issues.map((issue) => {
			const line = doc.line(Math.min(doc.lines, Math.max(1, issue.line)));
			const from = Math.min(line.to, line.from + Math.max(0, issue.column - 1));
			const endLine = issue.endLine
				? doc.line(Math.min(doc.lines, Math.max(1, issue.endLine)))
				: line;
			const to = Math.max(from, Math.min(endLine.to, endLine.from + Math.max(0, (issue.endColumn ?? issue.column) - 1)));
			return { from, to, severity: issue.severity, message: issue.message, source: issue.source };
		});
		this.editor.dispatch(setDiagnostics(this.editor.state, diagnostics));
		this.session?.mirrorDiagnostics(this, diagnostics);
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
		// Obsidian does not expose the tab header on WorkspaceLeaf's public type,
		// but it is the stable element used by the desktop tab UI. Keep the
		// internal access isolated here and gracefully degrade on mobile.
		this.tabHeaderEl = (this.leaf as WorkspaceLeaf & {
			tabHeaderEl?: HTMLElement;
		}).tabHeaderEl ?? null;
		this.applyFontVars();
		this.editor = new EditorView({
			state: this.buildState(this.data ?? ""),
			parent: this.contentEl,
		});
		this.updateTabBreadcrumb();
		this.updateNavigationBreadcrumb();
		this.installCloseGuard();
	}

	/** Keep the compact current-function context in the editor's tab title. */
	private updateTabBreadcrumb(): void {
		const editor = this.editor;
		const titleEl = this.tabHeaderEl?.querySelector<HTMLElement>(
			".workspace-tab-header-inner-title",
		);
		if (!editor || !titleEl) return;

		const selected = currentFunction(
			editor.state,
			editor.state.selection.main.head,
			this.stickyLanguageId(),
		);
		const existing = titleEl.querySelector<HTMLElement>(".onyx-tab-function");
		if (!selected) {
			existing?.remove();
			return;
		}
		const crumb = existing ?? titleEl.createSpan({ cls: "onyx-tab-function" });
		crumb.textContent = ` › ${selected.name}`;
		crumb.title = selected.name;
	}

	/** Add the current arbitrary scope chain to Obsidian's in-pane file breadcrumbs. */
	private updateNavigationBreadcrumb(): void {
		const editor = this.editor;
		const titleContainer = this.containerEl.querySelector<HTMLElement>(
			".view-header-title-container",
		);
		const fileTitle = titleContainer?.querySelector<HTMLElement>(
			".view-header-title",
		);
		if (!editor || !titleContainer || !fileTitle) return;

		const scopes = scopeChain(
			editor.state,
			editor.state.selection.main.head,
			this.stickyLanguageId(),
		);
		const existing = titleContainer.querySelector<HTMLElement>(".onyx-scope-breadcrumbs");
		if (scopes.length === 0) {
			existing?.remove();
			return;
		}

		const crumbs = existing ?? titleContainer.createSpan({ cls: "onyx-scope-breadcrumbs" });
		// Obsidian keeps the folder breadcrumb and file title as siblings. Insert
		// after the latter so scopes read as an extension of the file path.
		fileTitle.insertAdjacentElement("afterend", crumbs);
		crumbs.empty();
		for (const scope of scopes) {
			crumbs.createSpan({ cls: "onyx-scope-separator", text: "›" });
			const crumb = crumbs.createEl("button", {
				cls: "view-header-breadcrumb onyx-scope-breadcrumb",
				text: scope.name,
			});
			crumb.type = "button";
			crumb.title = `Jump to ${scope.kind} ${scope.name}`;
			crumb.addEventListener("click", () => {
				editor.dispatch({
					selection: { anchor: scope.from },
					effects: EditorView.scrollIntoView(scope.from, { y: "center" }),
				});
				editor.focus();
			});
		}
	}

	private installCloseGuard(): void {
		if (this.originalLeafDetach) return;
		const leaf = this.leaf;
		this.originalLeafDetach = leaf.detach.bind(leaf);
		this.originalLeafOpenFile = leaf.openFile.bind(leaf);
		leaf.detach = () => this.requestClose();
		leaf.openFile = (file, openState) => this.requestFileSwitch(file, openState);
	}

	private requestFileSwitch(file: TFile, openState?: OpenViewState): Promise<void> {
		if (file.path === this.file?.path || !this.session?.dirty || this.session.size > 1) {
			return this.originalLeafOpenFile?.(file, openState) ?? Promise.resolve();
		}
		if (this.closePromptOpen) return Promise.resolve();
		this.closePromptOpen = true;
		return new Promise((resolveOpen) => {
			new DirtyCloseModal(this.app, this.file?.name ?? this.getDisplayText(), (choice) => {
				this.closePromptOpen = false;
				if (choice === "cancel") {
					resolveOpen();
					return;
				}
				void this.finishConfirmedSwitch(file, openState, choice === "discard")
					.finally(resolveOpen);
			}, "switching").open();
		});
	}

	private async finishConfirmedSwitch(
		file: TFile,
		openState: OpenViewState | undefined,
		discard: boolean,
	): Promise<void> {
		if (!this.session) return;
		if (discard) {
			this.discardOnClose = true;
			this.session.discardPendingChanges();
		} else {
			try {
				await this.session.flush();
			} catch (error) {
				console.error("Onyx: could not save before switching files:", error);
				new Notice("Could not save changes; the current file was left open.");
				return;
			}
		}
		await this.originalLeafOpenFile?.(file, openState);
	}

	private requestClose(): void {
		if (this.closeApproved || !this.session?.dirty || this.session.size > 1) {
			this.originalLeafDetach?.();
			return;
		}
		if (this.closePromptOpen) return;
		this.closePromptOpen = true;
		new DirtyCloseModal(this.app, this.file?.name ?? this.getDisplayText(), (choice) => {
			this.closePromptOpen = false;
			if (choice === "cancel") return;
			void this.finishConfirmedClose(choice === "discard");
		}).open();
	}

	private async finishConfirmedClose(discard: boolean): Promise<void> {
		if (!this.session) return;
		if (discard) {
			this.discardOnClose = true;
			this.session.discardPendingChanges();
		} else {
			try {
				await this.session.flush();
			} catch (error) {
				console.error("Onyx: could not save before closing:", error);
				new Notice("Could not save changes; the tab was left open.");
				return;
			}
		}
		this.closeApproved = true;
		this.originalLeafDetach?.();
	}

	async onClose(): Promise<void> {
		this.containerEl.querySelector(".onyx-scope-breadcrumbs")?.remove();
		this.tabHeaderEl?.querySelector(".onyx-tab-function")?.remove();
		this.tabHeaderEl?.removeClass("onyx-tab-dirty");
		this.tabHeaderEl = null;
		if (this.originalLeafDetach) {
			this.leaf.detach = this.originalLeafDetach;
			this.originalLeafDetach = null;
		}
		if (this.originalLeafOpenFile) {
			this.leaf.openFile = this.originalLeafOpenFile;
			this.originalLeafOpenFile = null;
		}
		// Obsidian usually runs onUnloadFile before onClose on leaf close, but
		// it isn't guaranteed. Tear the session down here too; detach() and
		// releaseSession() are both idempotent, so the normal double call is a
		// no-op and a missed onUnloadFile no longer leaks a session + server.
		if (this.session && this.file) {
			if (!this.discardOnClose) {
				try {
					await this.session.flush();
				} catch {
					/* best effort while the leaf is going away */
				}
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
		this.updateTabBreadcrumb();
		this.updateNavigationBreadcrumb();
	}

	async onUnloadFile(file: TFile): Promise<void> {
		const discard = this.discardOnClose;
		this.discardOnClose = false;
		if (this.session) {
			if (!discard) await this.session.flush();
			this.session.detach(this);
			this.plugin.releaseSession(file.path);
			this.session = null;
		}
		await super.onUnloadFile(file);
	}

	async save(clear?: boolean): Promise<void> {
		const file = this.file;
		if (file && !(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) {
			await this.app.vault.adapter.write(file.path, this.getViewData());
		} else {
			await super.save(clear);
		}
		this.session?.markSaved();
		if (this.plugin.settings.lintTrigger === "onSave") void this.plugin.lintView(this, false);
	}

	refreshDirtyIndicator(): void {
		this.tabHeaderEl?.toggleClass("onyx-tab-dirty", this.session?.dirty ?? false);
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
			EditorState.tabSize.of(this.plugin.settings.tabSize),
			indentUnit.of(" ".repeat(this.plugin.settings.tabSize)),
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
				if (update.docChanged || update.selectionSet) {
					this.updateTabBreadcrumb();
					this.updateNavigationBreadcrumb();
				}
				let diagnosticsChanged = false;
				// Server-published diagnostics land on the workspace's elected
				// view only — mirror them so every pane shows the underlines.
				for (const tr of update.transactions) {
					for (const effect of tr.effects) {
						if (effect.is(setDiagnosticsEffect)) {
							diagnosticsChanged = true;
							if (!tr.annotation(mirroredEdit)) {
								this.session?.mirrorDiagnostics(
									this,
									effect.value,
								);
							}
						}
					}
				}
				if (diagnosticsChanged) this.plugin.updateLspStatusBar();

				if (!update.docChanged) return;
				this.plugin.scheduleSymbolsRefresh();
				this.data = update.state.doc.toString();

				const mirrored = update.transactions.some((tr) =>
					tr.annotation(mirroredEdit),
				);
				if (mirrored) return;

				this.session?.handleLocalChange(this, update.changes);
				this.plugin.scheduleLint(this);
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
