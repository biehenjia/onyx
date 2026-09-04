import {
	FuzzySuggestModal,
	ItemView,
	Menu,
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
	gitStatus(rootPath: string): Promise<Map<string, GitFileStatus>>;
	isDirty(path: string): boolean;
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

class FolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(
		app: WorkspaceExplorerPane["app"],
		private readonly pick: (folder: TFolder) => void,
	) {
		super(app);
		this.setPlaceholder("Choose workspace folder...");
	}

	getItems(): TFolder[] {
		return this.app.vault
			.getAllLoadedFiles()
			.filter((item): item is TFolder => item instanceof TFolder)
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
	private rootPath = "";
	private collapsed = new Set<string>();
	private filesEl: HTMLElement | null = null;
	private gitStatuses = new Map<string, GitFileStatus>();
	private refreshGeneration = 0;

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
		return this.rootPath.split("/").pop() || this.app.vault.getName();
	}

	getState(): Record<string, unknown> {
		return { rootPath: this.rootPath };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = (state as { rootPath?: unknown } | null)?.rootPath;
		this.rootPath = typeof next === "string" ? next : "";
		await super.setState(state, result);
		void this.refresh();
	}

	setRoot(path: string): void {
		this.rootPath = path;
		this.collapsed.clear();
		this.app.workspace.requestSaveLayout();
		void this.refresh();
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("onyx-workspace-explorer-content");
		this.addAction("file-plus", "New source file", () =>
			this.deps.newFile(this.rootPath),
		);
		this.addAction("folder-search", "Change workspace folder", () =>
			this.openFolderPicker(),
		);

		const header = this.contentEl.createDiv({ cls: "nav-header" });
		const toolbar = header.createDiv({ cls: "nav-buttons-container" });
		this.addToolbarButton(toolbar, "file-plus", "New source file", () =>
			this.deps.newFile(this.rootPath),
		);
		this.addToolbarButton(toolbar, "folder-search", "Change workspace folder", () =>
			this.openFolderPicker(),
		);
		this.addToolbarButton(toolbar, "fold", "Collapse all", () => {
			this.collapseAll();
			this.renderTree();
		});

		this.filesEl = this.contentEl.createDiv({ cls: "nav-files-container" });
		this.registerEvent(this.app.vault.on("create", () => void this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => void this.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => void this.refresh()));
		this.registerEvent(this.app.vault.on("modify", () => void this.refresh()));
		void this.refresh();
	}

	private addToolbarButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): void {
		const button = parent.createDiv({ cls: "clickable-icon nav-action-button" });
		button.setAttr("aria-label", label);
		setIcon(button, icon);
		button.addEventListener("click", onClick);
	}

	private openFolderPicker(): void {
		new FolderPicker(this.app, (folder) => this.setRoot(folder.path)).open();
	}

	private rootFolder(): TFolder | null {
		const item = this.rootPath
			? this.app.vault.getAbstractFileByPath(this.rootPath)
			: this.app.vault.getRoot();
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
		const root = this.rootFolder();
		if (!root) {
			this.filesEl.createDiv({
				cls: "onyx-workspace-empty",
				text: "Workspace folder no longer exists.",
			});
			return;
		}
		for (const child of [...root.children].sort(compareFiles)) {
			this.renderItem(this.filesEl, child);
		}
	}

	private renderItem(parent: HTMLElement, item: TAbstractFile): void {
		if (this.isObsidianExcluded(item.path)) return;
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

	private isObsidianExcluded(path: string): boolean {
		const cache = this.app.metadataCache as unknown as MetadataCacheWithIgnore;
		return cache.isUserIgnored?.(path) ?? false;
	}

	async refresh(): Promise<void> {
		const generation = ++this.refreshGeneration;
		const statuses = await this.deps.gitStatus(this.rootPath);
		if (generation !== this.refreshGeneration) return;
		this.gitStatuses = statuses;
		this.renderTree();
	}

	private renderFile(parent: HTMLElement, file: TFile): void {
		const item = parent.createDiv({ cls: "tree-item nav-file" });
		const title = item.createDiv({ cls: "tree-item-self is-clickable nav-file-title" });
		title.setAttr("data-path", file.path);
		const status = this.gitStatuses.get(file.path);
		if (status) {
			title.addClass("onyx-git-file", `mod-${status}`);
			title.setAttr("data-git-status", status);
		}
		if (this.deps.isDirty(file.path)) title.addClass("onyx-buffer-dirty");
		title.createDiv({ cls: "tree-item-inner nav-file-title-content", text: file.name });
		title.addEventListener("click", () => void this.app.workspace.openLinkText(file.path, "", false));
			title.addEventListener("contextmenu", (event) => {
				const menu = new Menu();
			menu.addItem((entry) =>
				entry.setTitle("Open in new tab").setIcon("file-plus").onClick(() =>
					void this.app.workspace.openLinkText(file.path, "", true),
				),
				);
				menu.showAtMouseEvent(event);
		});
	}

	private renderFolder(parent: HTMLElement, folder: TFolder): void {
		const isCollapsed = this.collapsed.has(folder.path);
		const item = parent.createDiv({ cls: "tree-item nav-folder" });
		if (isCollapsed) item.addClass("is-collapsed");
		const title = item.createDiv({
			cls: "tree-item-self is-clickable mod-collapsible nav-folder-title",
		});
		title.setAttr("data-path", folder.path);
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
				entry.setTitle("Use as workspace root").setIcon("folder-root").onClick(() =>
					this.setRoot(folder.path),
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
}
