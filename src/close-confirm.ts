import { App, Modal, Setting } from "obsidian";
import type { ButtonComponent } from "obsidian";

export type DirtyCloseChoice = "save" | "discard" | "cancel";

function markDestructive(button: ButtonComponent): ButtonComponent {
	const methods = button as unknown as Record<string, unknown>;
	const apply = (methods["setDestructive"] ?? methods["setWarning"]) as () => ButtonComponent;
	return apply.call(button);
}

/** Confirm the only close operation that could make the last live buffer vanish. */
export class DirtyCloseModal extends Modal {
	private done = false;

	constructor(
		app: App,
		private readonly fileName: string,
		private readonly onResolve: (choice: DirtyCloseChoice) => void,
		private readonly action: "closing" | "switching" = "closing",
	) {
		super(app);
	}

	private resolve(choice: DirtyCloseChoice): void {
		if (this.done) return;
		this.done = true;
		this.close();
		this.onResolve(choice);
	}

	onOpen(): void {
		this.titleEl.setText(`Save changes before ${this.action}?`);
		this.contentEl.createEl("p", {
			text: `“${this.fileName}” has unsaved changes.`,
		});

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.resolve("cancel")),
			)
			.addButton((button) =>
				markDestructive(button)
					.setButtonText("Don’t save")
					.onClick(() => this.resolve("discard")),
			)
			.addButton((button) =>
				button
					.setButtonText("Save")
					.setCta()
					.onClick(() => this.resolve("save")),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) {
			this.done = true;
			this.onResolve("cancel");
		}
	}
}
