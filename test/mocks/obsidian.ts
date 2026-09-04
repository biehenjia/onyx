/**
 * Minimal stand-ins for the Obsidian runtime API, aliased in for `obsidian`
 * imports during tests (see `vitest.config.mts`). Only the surface that
 * unit-tested modules actually touch at runtime is implemented; everything else
 * is a bare class so `instanceof` / `extends` still parse.
 *
 * Grow this as tests reach further into Obsidian-bound code.
 */

export class Notice {
	constructor(public message: string) {}
	setMessage(message: string): this {
		this.message = message;
		return this;
	}
	hide(): void {}
}

export class TFile {
	path = "";
	basename = "";
	extension = "";
}

export class TAbstractFile {}

export class Plugin {}
export class PluginSettingTab {}
export class TextFileView {}
export class ItemView {}
export class WorkspaceLeaf {}
export class App {}

export function normalizePath(path: string): string {
	return path.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function stubEl(): Record<string, (...a: unknown[]) => unknown> {
	const el: Record<string, (...a: unknown[]) => unknown> = {};
	for (const m of ["setText", "empty", "addClass", "removeClass"]) {
		el[m] = () => el;
	}
	el.createEl = () => stubEl();
	el.createDiv = () => stubEl();
	return el;
}

/** Chainable no-op stand-in for Setting / its component builders. */
class Chainable {
	private handler(): this {
		return this;
	}
	setName = this.handler;
	setDesc = this.handler;
	setHeading = this.handler;
	setButtonText = this.handler;
	setWarning = this.handler;
	setCta = this.handler;
	setValue = this.handler;
	setLimits = this.handler;
	setPlaceholder = this.handler;
	onClick = this.handler;
	onChange = this.handler;
	addButton = (cb: (c: Chainable) => void) => {
		cb(new Chainable());
		return this;
	};
	addText = this.addButton;
	addSlider = this.addButton;
	addToggle = this.addButton;
	addDropdown = this.addButton;
}

export class Setting extends Chainable {
	constructor(_containerEl?: unknown) {
		super();
	}
}

export class Modal {
	app: App;
	titleEl = stubEl();
	contentEl = stubEl();
	containerEl = stubEl();
	constructor(app: App) {
		this.app = app;
	}
	open(): void {
		this.onOpen();
	}
	close(): void {
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}

export class FuzzySuggestModal<T> extends Modal {
	setPlaceholder(_placeholder: string): void {}
	getItems(): T[] { return []; }
	getItemText(_item: T): string { return ""; }
	onChooseItem(_item: T): void {}
}

export class Menu {
	addItem(callback: (item: Chainable) => void): this {
		callback(new Chainable());
		return this;
	}
	showAtMouseEvent(_event: MouseEvent): void {}
}

export class TFolder extends TAbstractFile {
	name = "";
	children: TAbstractFile[] = [];
	isRoot(): boolean { return this.path === ""; }
}

export function setIcon(_el: HTMLElement, _icon: string): void {}

export class FileSystemAdapter {
	getBasePath(): string {
		return "/";
	}
	getFullPath(p: string): string {
		return p;
	}
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
	return { html } as unknown as DocumentFragment;
}
