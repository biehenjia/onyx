import { App, Modal, Setting } from "obsidian";
import type { LspSetup } from "./setup";

export class LspTrustModal extends Modal {
	constructor(app: App, private readonly project: LspSetup, private readonly approve: () => void) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`Trust ${this.project.name}?`);
		this.contentEl.createEl("p", { text: "This project asks onyx to execute:" });
		this.contentEl.createEl("pre").createEl("code", {
			text: this.project.command.map((part) => JSON.stringify(part)).join(" "),
		});
		this.contentEl.createEl("p", { text: this.project.configPath });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => button.setButtonText("Trust and run").setCta().onClick(() => {
				this.approve();
				this.close();
			}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
