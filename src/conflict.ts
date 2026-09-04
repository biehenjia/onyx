import { App, Modal, Setting } from "obsidian";
import type { ButtonComponent } from "obsidian";

export type ConflictChoice = "reload" | "keep";

function markDestructive(button: ButtonComponent): ButtonComponent {
	const methods = button as unknown as Record<string, unknown>;
	const apply = (methods["setDestructive"] ?? methods["setWarning"]) as () => ButtonComponent;
	return apply.call(button);
}

/**
 * Shown when a file changes on disk (git checkout, formatter, another editor)
 * while Onyx holds unsaved edits for it. Resolves exactly once: either button,
 * or dismissal (Esc / click-away) which counts as "keep" so unsaved work is
 * never dropped without an explicit choice.
 */
export class ExternalChangeModal extends Modal {
	private done = false;

	constructor(
		app: App,
		private readonly fileName: string,
		private readonly onResolve: (choice: ConflictChoice) => void,
	) {
		super(app);
	}

	private resolve(choice: ConflictChoice): void {
		if (this.done) return;
		this.done = true;
		this.close();
		this.onResolve(choice);
	}

	onOpen(): void {
		this.titleEl.setText("File changed on disk");
		this.contentEl.createEl("p", {
			text: `"${this.fileName}" was modified outside Onyx while you have unsaved changes here. Keep which version?`,
		});

		new Setting(this.contentEl)
			.addButton((b) =>
				markDestructive(b)
					.setButtonText("Reload from disk")
					.onClick(() => this.resolve("reload")),
			)
			.addButton((b) =>
				b
					.setButtonText("Keep my version")
					.setCta()
					.onClick(() => this.resolve("keep")),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		// Dismissed without choosing — don't discard the editor's edits.
		if (!this.done) {
			this.done = true;
			this.onResolve("keep");
		}
	}
}
