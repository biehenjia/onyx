import {
	FuzzySuggestModal,
	ItemView,
	Menu,
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	setIcon,
	type ViewStateResult,
} from "obsidian";
import type { GitFileStatus } from "./git";

export const WORKSPACE_EXPLORER_VIEW = "onyx-workspace-explorer";

export interface WorkspaceExplorerDeps {
	newFile(folder: string): void;
	openFile(file: TFile, newLeaf: boolean): Promise<void>;
	gitStatus(rootPath: string): Promise<Map<string, GitFileStatus>>;
	isDirty(path: string): boolean;
	workspacePaths(): readonly string[];
	addWorkspace(path: string): Promise<void>;
}

interface MetadataCacheWithIgnore {
	isUserIgnored?(path: string): boolean;
}

const HIDDEN_DIRECTORY_NAMES = new Set([
	".git",
	".hg",
	".svn",
	".direnv",
	".venv",
	"__pycache__",
	"node_modules",
	"target",
	"dist",
	"build",
	"coverage",
]);

const HIDDEN_FILE_NAMES = new Set([
	".DS_Store",
	"Thumbs.db",
	"desktop.ini",
]);

const BINARY_EXTENSIONS = new Set([
	"7z", "a", "avi", "avif", "bin", "bmp", "class", "dmg", "dll",
	"doc", "docx", "dylib", "eot", "exe", "gif", "gz", "ico", "jar",
	"jpeg", "jpg", "lockb", "mov", "mp3", "mp4", "o", "obj", "otf",
	"pdf", "png", "pyc", "pyo", "rar", "so", "tar", "tiff", "ttf",
	"wav", "webm", "webp", "woff", "woff2", "xls", "xlsx", "zip",
]);

const EXPLORER_DRAG_TYPE = "application/x-onyx-workspace-path";

export type MoveDestination =
	| { path: string }
	| { error: string };

/** Paths of folders explicitly marked as workspaces by a direct onyx.toml. */
export function workspaceRootPaths(files: readonly Pick<TFile, "name" | "path">[]): string[] {
	return [...new Set(files
		.filter((file) => file.name === "onyx.toml")
		.map((file) => file.path.includes("/")
			? file.path.slice(0, file.path.lastIndexOf("/"))
			: ""))]
		.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The nearest marked workspace containing a vault-relative file path. */
export function workspaceRootForPath(
	path: string | null | undefined,
	workspaceRoots: readonly string[],
): string | null {
	if (!path) return null;
	return [...workspaceRoots]
		.sort((a, b) => b.length - a.length)
		.find((root) => root === "" || path === root || path.startsWith(`${root}/`))
		?? null;
}

/** Resolve and validate a drag move without touching the vault. */
export function getMoveDestination(
	sourcePath: string,
	sourceIsFolder: boolean,
	targetFolderPath: string,
	destinationExists: boolean,
): MoveDestination {
	const name = sourcePath.split("/").pop();
	if (!name) return { error: "The workspace root cannot be moved." };
	const destination = targetFolderPath ? `${targetFolderPath}/${name}` : name;
	if (destination === sourcePath) return { error: "The item is already in that folder." };
	if (sourceIsFolder && (
		targetFolderPath === sourcePath
		|| targetFolderPath.startsWith(`${sourcePath}/`)
	)) {
		return { error: "A folder cannot be moved inside itself." };
	}
	if (destinationExists) {
		return { error: `An item named “${name}” already exists in that folder.` };
	}
	return { path: destination };
}

/** Workspace visibility beyond Obsidian's own excluded-file filter. */
export function isWorkspaceItemVisible(
	name: string,
	isFolder: boolean,
	extension = "",
): boolean {
	if (isFolder) return !HIDDEN_DIRECTORY_NAMES.has(name);
	if (HIDDEN_FILE_NAMES.has(name)) return false;
	return !BINARY_EXTENSIONS.has(extension.toLowerCase());
}

function compareFiles(a: TAbstractFile, b: TAbstractFile): number {
	if (a instanceof TFolder && !(b instanceof TFolder)) return -1;
	if (!(a instanceof TFolder) && b instanceof TFolder) return 1;
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

class WorkspacePicker extends FuzzySuggestModal<TFolder> {
	constructor(
		app: WorkspaceExplorerPane["app"],
		placeholder: string,
		private readonly paths: readonly string[],
		private readonly pick: (folder: TFolder) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): TFolder[] {
		const roots = new Set(workspaceRootPaths(this.app.vault.getFiles()));
		const allowed = new Set(this.paths);
		return this.app.vault.getAllLoadedFiles()
			.filter((item): item is TFolder =>
				item instanceof TFolder && roots.has(item.path) && allowed.has(item.path))
			.sort(compareFiles);
	}

	getItemText(folder: TFolder): string {
		return folder.isRoot() ? this.app.vault.getName() : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.pick(folder);
	}
}

export class WorkspaceExplorerPane extends ItemView {
	/** null means no marked workspace has been selected yet. */
	private rootPath: string | null = null;
	/** A folder shown by itself, while retaining rootPath as the workspace root. */
	private focusedPath: string | null = null;
	private collapsed = new Set<string>();
	private filesEl: HTMLElement | null = null;
	private focusToggleButton: HTMLElement | null = null;
	private activeHighlightEl: HTMLElement | null = null;
	private gitStatuses = new Map<string, GitFileStatus>();
	private refreshGeneration = 0;
	private activeFilePath: string | null = null;
	private draggedItem: TAbstractFile | null = null;
	private dropTargetFolder: HTMLElement | null = null;
	private adapterGitIgnore: TFile | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly deps: WorkspaceExplorerDeps) {
		super(leaf);
	}

	getViewType(): string {
		return WORKSPACE_EXPLORER_VIEW;
	}

	getIcon(): string {
		return "folder-tree";
	}

	getDisplayText(): string {
		if (this.rootPath === null) return "Workspace explorer";
		return this.rootPath.split("/").pop() || this.app.vault.getName();
	}

	getState(): Record<string, unknown> {
		return { rootPath: this.rootPath, focusedPath: this.focusedPath };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = (state as { rootPath?: unknown; focusedPath?: unknown } | null);
		const candidateRoot = typeof next?.rootPath === "string" ? next.rootPath : null;
		this.rootPath = candidateRoot !== null
			&& workspaceRootPaths(this.app.vault.getFiles()).includes(candidateRoot)
			&& this.deps.workspacePaths().includes(candidateRoot)
			? candidateRoot
			: null;
		this.focusedPath = typeof next?.focusedPath === "string" ? next.focusedPath : null;
		await super.setState(state, result);
		void this.refresh();
	}

	setRoot(path: string): void {
		this.rootPath = path;
		this.focusedPath = null;
		this.collapsed.clear();
		this.app.workspace.requestSaveLayout();
		void this.refresh();
	}

	private setFocusedFolder(path: string): void {
		this.focusedPath = path;
		this.collapsed.clear();
		this.app.workspace.requestSaveLayout();
		void this.refresh();
	}

	private clearFolderFocus(): void {
		if (this.focusedPath === null) return;
		this.focusedPath = null;
		this.app.workspace.requestSaveLayout();
		this.renderTree();
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("onyx-workspace-explorer-content");
		this.addAction("file-plus", "New source file", () =>
			this.deps.newFile(this.focusedPath ?? this.rootPath ?? ""),
		);
		this.addAction("folder-search", "Select workspace", () =>
			this.openWorkspacePicker(),
		);
		this.addAction("folder-plus", "Add workspace", () =>
			this.openAddWorkspacePicker(),
		);

		const header = this.contentEl.createDiv({ cls: "nav-header" });
		const toolbar = header.createDiv({ cls: "nav-buttons-container" });
		this.addToolbarButton(toolbar, "file-plus", "New source file", () =>
			this.deps.newFile(this.focusedPath ?? this.rootPath ?? ""),
		);
		this.addToolbarButton(toolbar, "folder-plus", "Add workspace", () =>
			this.openAddWorkspacePicker(),
		);
		this.addToolbarButton(toolbar, "folder-search", "Select workspace", () =>
			this.openWorkspacePicker(),
		);
		this.focusToggleButton = this.addToolbarButton(
			toolbar,
			"maximize-2",
			"Show entire workspace",
			() => this.clearFolderFocus(),
		);
		this.addToolbarButton(toolbar, "fold", "Collapse all", () => {
			this.collapseAll();
			this.renderTree();
		});

		this.filesEl = this.contentEl.createDiv({
			cls: "nav-files-container node-insert-event",
		});
		this.filesEl.setAttr("role", "tree");
		this.filesEl.setAttr("aria-label", "Workspace files");
		this.filesEl.addEventListener("dragover", (event) => {
			if (!this.draggedItem) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
			this.showDropTarget(this.dropFolderAt(event.target));
		});
		this.filesEl.addEventListener("dragleave", (event) => {
			if (event.relatedTarget instanceof Node && this.filesEl?.contains(event.relatedTarget)) return;
			this.clearDropTarget();
		});
		this.filesEl.addEventListener("drop", (event) => {
			if (!this.draggedItem) return;
			event.preventDefault();
			const targetFolder = this.dropFolderAt(event.target);
			this.clearDropTarget();
			void this.moveDraggedItem(targetFolder?.dataset.dropPath ?? this.focusedPath ?? this.rootPath ?? "");
		});
		this.registerEvent(this.app.vault.on("create", () => void this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => void this.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => void this.refresh()));
		this.registerEvent(this.app.vault.on("modify", () => void this.refresh()));
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			this.setActiveFile(file?.path ?? null);
		}));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			this.setActiveFile(this.app.workspace.getActiveFile()?.path ?? null);
		}));
		this.activeFilePath = this.app.workspace.getActiveFile()?.path ?? null;
		void this.refresh();
	}

	private addToolbarButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLElement {
		const button = parent.createDiv({ cls: "clickable-icon nav-action-button" });
		button.setAttr("aria-label", label);
		setIcon(button, icon);
		button.addEventListener("click", onClick);
		return button;
	}

	private openWorkspacePicker(): void {
		const paths = this.validWorkspacePaths(this.deps.workspacePaths());
		if (paths.length === 0) {
			new Notice("Add a workspace first.");
			return;
		}
		new WorkspacePicker(this.app, "Choose workspace...", paths, (folder) =>
			this.setRoot(folder.path),
		).open();
	}

	private openAddWorkspacePicker(): void {
		const added = new Set(this.deps.workspacePaths());
		const paths = workspaceRootPaths(this.app.vault.getFiles())
			.filter((path) => !added.has(path));
		if (paths.length === 0) {
			new Notice("No unadded folders with a top-level onyx.toml were found.");
			return;
		}
		new WorkspacePicker(this.app, "Add workspace...", paths, (folder) => {
			void this.deps.addWorkspace(folder.path).then(
				() => this.setRoot(folder.path),
				() => new Notice(`Could not add workspace “${folder.name}”.`),
			);
		}).open();
	}

	private validWorkspacePaths(paths: readonly string[]): string[] {
		const available = new Set(workspaceRootPaths(this.app.vault.getFiles()));
		return paths.filter((path) => available.has(path));
	}

	private rootFolder(): TFolder | null {
		if (this.rootPath === null) return null;
		const item = this.rootPath
			? this.app.vault.getAbstractFileByPath(this.rootPath)
			: this.app.vault.getRoot();
		return item instanceof TFolder ? item : null;
	}

	private focusedFolder(): TFolder | null {
		if (this.focusedPath === null || this.rootPath === null) return null;
		if (this.rootPath && this.focusedPath !== this.rootPath
			&& !this.focusedPath.startsWith(`${this.rootPath}/`)) return null;
		const item = this.app.vault.getAbstractFileByPath(this.focusedPath);
		return item instanceof TFolder ? item : null;
	}

	private collapseAll(): void {
		const visit = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					this.collapsed.add(child.path);
					visit(child);
				}
			}
		};
		const root = this.rootFolder();
		if (root) visit(root);
	}

	private renderTree(): void {
		if (!this.filesEl) return;
		this.filesEl.empty();
		this.activeHighlightEl = this.filesEl.createDiv({
			cls: "onyx-workspace-active-highlight",
		});
		this.filesEl.removeClass("onyx-workspace-folder-focused");
		this.focusToggleButton?.removeClass("is-active");
		const root = this.rootFolder();
		if (!root) {
			this.filesEl.createDiv({
				cls: "onyx-workspace-empty",
				text: this.rootPath === null
					? "Select a workspace marked by onyx.toml."
					: "Workspace folder no longer exists.",
			});
			return;
		}
		const displayRoot = this.focusedFolder() ?? root;
		const focused = displayRoot !== root;
		this.filesEl.toggleClass("onyx-workspace-folder-focused", focused);
		this.focusToggleButton?.toggleClass("is-active", focused);
		if (this.focusToggleButton) {
			this.focusToggleButton.setAttr(
				"aria-label",
				focused ? "Show entire workspace" : "No folder focus active",
			);
		}
		// Obsidian's file explorer keeps its virtual root out of the DOM.
		// Render top-level entries directly to avoid giving that invisible level
		// an indentation guide and retain the native class hierarchy.
		for (const child of [...displayRoot.children].sort(compareFiles)) {
			this.renderItem(this.filesEl, child);
		}
		if (this.adapterGitIgnore && displayRoot === root && !root.children.some(
			(child) => child.path === this.adapterGitIgnore?.path,
		)) this.renderFile(this.filesEl, this.adapterGitIgnore);
		this.positionActiveHighlight();
	}

	private setActiveFile(path: string | null): void {
		this.activeFilePath = path;
		if (!this.filesEl) return;
		this.filesEl.querySelectorAll<HTMLElement>(".nav-file-title").forEach((row) => {
			const active = row.dataset.path === path;
			row.classList.toggle("is-active", active);
			row.setAttribute("aria-selected", active ? "true" : "false");
		});
		this.positionActiveHighlight();
	}

	private positionActiveHighlight(): void {
		if (!this.filesEl || !this.activeHighlightEl) return;
		const row = Array.from(this.filesEl.querySelectorAll<HTMLElement>(".nav-file-title"))
			.find((candidate) => candidate.dataset.path === this.activeFilePath);
		if (!row) {
			this.activeHighlightEl.hide();
			return;
		}
		this.activeHighlightEl.show();
		this.activeHighlightEl.style.top = `${row.offsetTop}px`;
		this.activeHighlightEl.style.height = `${row.offsetHeight}px`;
	}

	private renderItem(parent: HTMLElement, item: TAbstractFile): void {
		// Keep .gitignore visible even when Obsidian's dotfile/excluded-file
		// handling or Git's own rules classify it as ignored.
		const isGitIgnoreFile = item.name === ".gitignore";
		if (!isGitIgnoreFile && this.isObsidianExcluded(item.path)) return;
		if (!isGitIgnoreFile && this.isGitIgnored(item.path)) return;
		const configDir = this.app.vault.configDir;
		if (item.path === configDir || item.path.startsWith(`${configDir}/`)) return;
		if (!isWorkspaceItemVisible(
			item.name,
			item instanceof TFolder,
			item instanceof TFile ? item.extension : "",
		)) return;
		if (item instanceof TFolder) this.renderFolder(parent, item);
		else if (item instanceof TFile) this.renderFile(parent, item);
	}

	private isGitIgnored(path: string): boolean {
		for (const [ignoredPath, status] of this.gitStatuses) {
			if (status === "ignored" && (
				path === ignoredPath || path.startsWith(`${ignoredPath}/`)
			)) return true;
		}
		return false;
	}

	private isObsidianExcluded(path: string): boolean {
		const cache = this.app.metadataCache as unknown as MetadataCacheWithIgnore;
		return cache.isUserIgnored?.(path) ?? false;
	}

	async refresh(): Promise<void> {
		const generation = ++this.refreshGeneration;
		if (this.rootPath === null) {
			this.gitStatuses.clear();
			this.adapterGitIgnore = null;
			this.renderTree();
			return;
		}
		const [statuses, adapterGitIgnore] = await Promise.all([
			this.deps.gitStatus(this.rootPath),
			this.findAdapterGitIgnore(),
		]);
		if (generation !== this.refreshGeneration) return;
		this.gitStatuses = statuses;
		this.adapterGitIgnore = adapterGitIgnore;
		this.renderTree();
	}

	/** Dotfiles can exist on disk without an entry in Obsidian's vault index. */
	private async findAdapterGitIgnore(): Promise<TFile | null> {
		if (this.rootPath === null) return null;
		const path = this.rootPath ? `${this.rootPath}/.gitignore` : ".gitignore";
		if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) return null;
		try {
			const stat = await this.app.vault.adapter.stat(path);
			if (!stat || stat.type !== "file") return null;
			// Vault.read/openFile only require the public TFile fields; this bridge
			// lets TextFileView handle a file omitted from Vault's hidden-file index.
			// This is intentionally synthetic because no indexed TFile exists.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Object.create returns any in TypeScript's standard library.
			const file: TFile = Object.create(TFile.prototype);
			file.vault = this.app.vault;
			file.path = path;
			file.name = ".gitignore";
			file.basename = ".gitignore";
			file.extension = "";
			file.parent = this.rootFolder();
			file.stat = { ctime: stat.ctime, mtime: stat.mtime, size: stat.size };
			return file;
		} catch {
			return null;
		}
	}

	private renderFile(parent: HTMLElement, file: TFile): void {
		const item = parent.createDiv({ cls: "tree-item nav-file" });
		const title = item.createDiv({ cls: "tree-item-self is-clickable nav-file-title" });
		title.setAttr("data-path", file.path);
		this.makeDraggable(title, file);
		title.setAttr("role", "treeitem");
		title.setAttr("aria-selected", file.path === this.activeFilePath ? "true" : "false");
		if (file.path === this.activeFilePath) title.addClass("is-active");
		const status = this.gitStatuses.get(file.path);
		if (status) {
			title.addClass("onyx-git-file", `mod-${status}`);
			title.setAttr("data-git-status", status);
		}
		if (this.deps.isDirty(file.path)) title.addClass("onyx-buffer-dirty");
		title.createDiv({ cls: "tree-item-inner nav-file-title-content", text: file.name });
		// Pointerup still opens before Obsidian can rerender the sidebar, while
		// leaving pointerdown's native behavior available to start a drag.
		title.addEventListener("pointerup", (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			// Match Obsidian and ../tv: Cmd-click on macOS or Ctrl-click on
			// other platforms opens the file in a new editor tab.
			void this.deps.openFile(file, event.metaKey || event.ctrlKey);
		});
		// Keyboard activation produces a click without a pointer event.
		title.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.detail === 0) void this.deps.openFile(file, false);
		});
			title.addEventListener("contextmenu", (event) => {
				const menu = new Menu();
			menu.addItem((entry) =>
				entry.setTitle("Open in new tab").setIcon("file-plus").onClick(() =>
					void this.deps.openFile(file, true),
				),
				);
				menu.showAtMouseEvent(event);
		});
	}

	private renderFolder(parent: HTMLElement, folder: TFolder): void {
		const isCollapsed = this.collapsed.has(folder.path);
		const item = parent.createDiv({ cls: "tree-item nav-folder" });
		item.setAttr("data-drop-path", folder.path);
		if (isCollapsed) item.addClass("is-collapsed");
		const title = item.createDiv({
			cls: "tree-item-self is-clickable mod-collapsible nav-folder-title",
		});
		title.setAttr("data-path", folder.path);
		this.makeDraggable(title, folder);
		title.setAttr("role", "treeitem");
		title.setAttr("aria-expanded", isCollapsed ? "false" : "true");
		if ([...this.gitStatuses.keys()].some((path) => path.startsWith(`${folder.path}/`))) {
			title.addClass("onyx-git-folder");
		}
		const icon = title.createDiv({ cls: "tree-item-icon collapse-icon" });
		if (isCollapsed) icon.addClass("is-collapsed");
		setIcon(icon, "right-triangle");
		title.createDiv({ cls: "tree-item-inner nav-folder-title-content", text: folder.name });
		title.addEventListener("click", () => {
			if (isCollapsed) this.collapsed.delete(folder.path);
			else this.collapsed.add(folder.path);
			this.renderTree();
		});
		title.addEventListener("contextmenu", (event) => {
			const menu = new Menu();
			menu.addItem((entry) =>
				entry.setTitle("Focus this folder").setIcon("maximize-2").onClick(() =>
					this.setFocusedFolder(folder.path),
				),
			);
			menu.addItem((entry) =>
				entry.setTitle("New source file here").setIcon("file-plus").onClick(() =>
					this.deps.newFile(folder.path),
				),
				);
				menu.showAtMouseEvent(event);
		});

		if (!isCollapsed) {
			const children = item.createDiv({ cls: "tree-item-children nav-folder-children" });
			for (const child of [...folder.children].sort(compareFiles)) {
				this.renderItem(children, child);
		}
}
	}

	private makeDraggable(title: HTMLElement, item: TAbstractFile): void {
		title.setAttr("draggable", "true");
		title.addEventListener("dragstart", (event) => {
			this.draggedItem = item;
			title.addClass("is-being-dragged");
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData(EXPLORER_DRAG_TYPE, item.path);
				event.dataTransfer.setData("text/plain", item.path);
			}
		});
		title.addEventListener("dragend", () => {
			this.draggedItem = null;
			title.removeClass("is-being-dragged");
			this.clearDropTarget();
		});
	}

	/** The nearest tree branch owns its entire rendered subtree as a drop zone. */
	private dropFolderAt(target: EventTarget | null): HTMLElement | null {
		if (!(target instanceof Element)) return null;
		return target.closest<HTMLElement>(".nav-folder[data-drop-path]");
	}

	private clearDropTarget(): void {
		this.filesEl?.removeClass("onyx-drop-target");
		this.filesEl?.querySelectorAll(".is-being-dragged-over")
			.forEach((element) => element.removeClass("is-being-dragged-over"));
		this.dropTargetFolder = null;
	}

	private showDropTarget(folder: HTMLElement | null): void {
		if (folder === this.dropTargetFolder) return;
		this.clearDropTarget();
		this.dropTargetFolder = folder;
		if (!folder || folder.hasClass("mod-root")) {
			this.filesEl?.addClass("onyx-drop-target");
			return;
		}
		// Native explorer themes target either the folder container or its row,
		// depending on the Obsidian/theme version. Set the state on both.
		folder.addClass("is-being-dragged-over");
		const title = folder.firstElementChild;
		if (title instanceof HTMLElement && title.hasClass("nav-folder-title")) {
			title.addClass("is-being-dragged-over");
		}
	}

	private async moveDraggedItem(targetFolderPath: string): Promise<void> {
		const source = this.draggedItem;
		this.draggedItem = null;
		if (!source) return;
		const candidateName = source.path.split("/").pop() ?? "";
		const candidatePath = targetFolderPath
			? `${targetFolderPath}/${candidateName}`
			: candidateName;
		const result = getMoveDestination(
			source.path,
			source instanceof TFolder,
			targetFolderPath,
			this.app.vault.getAbstractFileByPath(candidatePath) !== null,
		);
		if ("error" in result) {
			if (result.error !== "The item is already in that folder.") new Notice(result.error);
			return;
		}
		try {
			await this.app.fileManager.renameFile(source, result.path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Could not move “${source.name}”: ${message}`);
		}
	}
}
