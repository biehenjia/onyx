import { App, Modal, Setting, TFile, normalizePath } from "obsidian";

export function parentPath(path: string | undefined): string {
	if (!path) return "";
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

export function newFilePath(input: string): string {
	const raw = input.trim().replaceAll("\\", "/");
	if (!raw || raw.endsWith("/")) throw new Error("Enter a file name.");
	if (raw.startsWith("/") || raw.split("/").some((part) => part === "..")) {
		throw new Error("Use a path inside this vault.");
	}

	const path = normalizePath(raw);
	const name = path.split("/").pop() ?? "";
	const dot = name.lastIndexOf(".");
	const extension = dot === 0 ? name.slice(1) : dot > 0 ? name.slice(dot + 1) : "";
	if (!extension) throw new Error("Include a file extension, such as .ts or .py.");
	if (extension.toLowerCase() === "md") {
		throw new Error("Use Obsidian's new note action for Markdown files.");
	}
	return path;
}

export class NewSourceFileModal extends Modal {
	private value: string;
	private errorEl: HTMLElement | null = null;
	private creating = false;

	constructor(
		app: App,
		initialPath: string,
		private readonly create: (path: string) => Promise<TFile>,
	) {
		super(app);
		this.value = initialPath;
	}

	onOpen(): void {
		this.titleEl.setText("New source file");
		this.contentEl.createEl("p", {
			text: "Enter a path relative to the vault. Missing folders will be created.",
		});

		new Setting(this.contentEl)
			.setName("File path")
			.addText((text) => {
				text.setPlaceholder("src/example.ts").setValue(this.value);
				text.onChange((value) => {
					this.value = value;
					this.showError("");
				});
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void this.submit();
					}
				});
				window.setTimeout(() => {
					text.inputEl.focus();
					text.inputEl.select();
				});
			})
			.addButton((button) =>
				button.setButtonText("Create").setCta().onClick(() => {
					void this.submit();
				}),
			);

		this.errorEl = this.contentEl.createDiv({ cls: "onyx-new-file-error" });
	}

	private showError(message: string): void {
		this.errorEl?.setText(message);
	}

	private async submit(): Promise<void> {
		if (this.creating) return;
		let path: string;
		try {
			path = newFilePath(this.value);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		this.creating = true;
		try {
			await this.create(path);
			this.close();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		} finally {
			this.creating = false;
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.errorEl = null;
	}
}
