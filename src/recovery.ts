import { App, Modal, Setting } from "obsidian";
import type { ButtonComponent } from "obsidian";

export interface RecoverySnapshot { text: string; diskText: string; updatedAt: number }
export type RecoveryChoice = "restore" | "disk";

function markDestructive(button: ButtonComponent): ButtonComponent {
	const methods = button as unknown as Record<string, unknown>;
	const apply = (methods["setDestructive"] ?? methods["setWarning"]) as () => ButtonComponent;
	return apply.call(button);
}

export class RecoveryModal extends Modal {
	private done = false;
	constructor(app: App, private readonly fileName: string, private readonly changedOnDisk: boolean, private readonly resolveChoice: (choice: RecoveryChoice) => void) { super(app); }
	private resolve(choice: RecoveryChoice): void { if (this.done) return; this.done = true; this.close(); this.resolveChoice(choice); }
	onOpen(): void {
		this.titleEl.setText("Recover unsaved edits");
		this.contentEl.createEl("p", { text: this.changedOnDisk
			? `Onyx recovered an unsaved buffer for “${this.fileName}”, but the file also changed on disk.`
			: `Onyx recovered unsaved edits for “${this.fileName}”.` });
		new Setting(this.contentEl)
			.addButton((b) => markDestructive(b).setButtonText("Use disk version").onClick(() => this.resolve("disk")))
			.addButton((b) => b.setButtonText("Restore buffer").setCta().onClick(() => this.resolve("restore")));
	}
	onClose(): void { this.contentEl.empty(); if (!this.done) { this.done = true; this.resolveChoice("restore"); } }
}
