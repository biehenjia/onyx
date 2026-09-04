import { App, PluginSettingTab, Setting } from "obsidian";
import type OnyxPlugin from "./main";

export type SavePolicy = "afterDelay" | "onFocusChange" | "manual";
export type ColorScheme = "onyx" | "obsidian";

export interface OnyxSettings {
	/** When edits are written to disk. */
	savePolicy: SavePolicy;
	/** Debounce before an `afterDelay` autosave writes (ms). */
	autoSaveDelayMs: number;
	/** Curated palette, or follow Obsidian's own code-block colours. */
	colorScheme: ColorScheme;
	/** "" -> Obsidian's --font-monospace. */
	fontFamily: string;
	/** px; 0 -> inherit Obsidian's editor font size. */
	fontSize: number;
	/** Unitless line height. */
	lineHeight: number;
	/** Programming ligatures (calt/liga). */
	ligatures: boolean;
	/** Draw indentation guides. */
	indentGuides: boolean;
	/** Brighten the guide for the current scope. */
	activeIndentGuide: boolean;
	/** Pin enclosing namespaces, types, and functions while scrolling. */
	stickyScroll: boolean;
	/** Connect language servers for supported files. */
	lspEnabled: boolean;
	/**
	 * Per-language-id command override, e.g. `{ "python": ["pyright-langserver",
	 * "--stdio"] }`. Empty entries fall back to auto-detection. Edit in data.json
	 * for now — no settings UI yet.
	 */
	lspServers: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: OnyxSettings = {
	savePolicy: "afterDelay",
	autoSaveDelayMs: 2000,
	colorScheme: "onyx",
	fontFamily: "",
	fontSize: 0,
	lineHeight: 1.5,
	ligatures: true,
	indentGuides: true,
	activeIndentGuide: true,
	stickyScroll: true,
	lspEnabled: true,
	lspServers: {},
};

export class OnyxSettingTab extends PluginSettingTab {
	private plugin: OnyxPlugin;

	constructor(app: App, plugin: OnyxPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private async commit(): Promise<void> {
		await this.plugin.saveSettings();
		this.plugin.applyStyleToOpenViews();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Save")
			.setDesc(
				"When to write edits to disk. After delay autosaves once you stop typing; on focus change saves when you leave the editor; manual saves only on cmd/ctrl-s.",
			)
			.addDropdown((dd) =>
				dd
					.addOption("afterDelay", "After delay (autosave)")
					.addOption("onFocusChange", "On focus change")
					.addOption("manual", "Manual only")
					.setValue(this.plugin.settings.savePolicy)
					.onChange(async (value) => {
						this.plugin.settings.savePolicy = value as SavePolicy;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.savePolicy === "afterDelay") {
			new Setting(containerEl)
				.setName("Autosave delay")
				.setDesc(
					"How long after you stop typing an autosave writes. The file shows as unsaved until then.",
				)
				.addSlider((slider) =>
					slider
						.setLimits(250, 5000, 250)
						.setValue(this.plugin.settings.autoSaveDelayMs)
						.onChange(async (value) => {
							this.plugin.settings.autoSaveDelayMs = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Language servers")
			.setDesc(
				"Connect a language server for supported files — hover, completion, signature help and diagnostics. Onyx looks for the server in the project's virtualenv and node modules, then the system path. Restart Obsidian after changing.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.lspEnabled)
					.onChange(async (value) => {
						this.plugin.settings.lspEnabled = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Appearance").setHeading();

		new Setting(containerEl)
			.setName("Colour scheme")
			.setDesc(
				"Onyx is a curated palette mapped onto Obsidian's colour primitives. Follow Obsidian theme reuses the theme's own code-block colours.",
			)
			.addDropdown((dd) =>
				dd
					.addOption("onyx", "Onyx")
					.addOption("obsidian", "Follow Obsidian theme")
					.setValue(this.plugin.settings.colorScheme)
					.onChange(async (value) => {
						this.plugin.settings.colorScheme = value as ColorScheme;
						await this.commit();
					}),
			);

		new Setting(containerEl)
			.setName("Font family")
			.setDesc("Leave empty to use Obsidian's monospace font.")
			.addText((text) =>
				text
					.setPlaceholder("Obsidian default")
					.setValue(this.plugin.settings.fontFamily)
					.onChange(async (value) => {
						this.plugin.settings.fontFamily = value.trim();
						await this.commit();
					}),
			);

		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Size in pixels; 0 inherits Obsidian's editor font size.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 24, 1)
					.setValue(this.plugin.settings.fontSize)
					.onChange(async (value) => {
						this.plugin.settings.fontSize = value;
						await this.commit();
					}),
			);

		new Setting(containerEl)
			.setName("Line height")
			.addSlider((slider) =>
				slider
					.setLimits(1.1, 2, 0.05)
					.setValue(this.plugin.settings.lineHeight)
					.onChange(async (value) => {
						this.plugin.settings.lineHeight = value;
						await this.commit();
					}),
			);

		new Setting(containerEl)
			.setName("Ligatures")
			.setDesc("Programming ligatures, if the font provides them.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.ligatures)
					.onChange(async (value) => {
						this.plugin.settings.ligatures = value;
						await this.commit();
					}),
			);

		new Setting(containerEl)
			.setName("Sticky scroll")
			.setDesc("Pin enclosing namespaces, types, and functions at the top of the editor.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.stickyScroll)
					.onChange(async (value) => {
						this.plugin.settings.stickyScroll = value;
						await this.commit();
					}),
			);

		new Setting(containerEl)
			.setName("Indentation guides")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.indentGuides)
					.onChange(async (value) => {
						this.plugin.settings.indentGuides = value;
						await this.commit();
					}),
			);

		new Setting(containerEl)
			.setName("Highlight active indentation guide")
			.setDesc("Brighten the guide for the current scope.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.activeIndentGuide)
					.onChange(async (value) => {
						this.plugin.settings.activeIndentGuide = value;
						await this.commit();
					}),
			);
	}
}
