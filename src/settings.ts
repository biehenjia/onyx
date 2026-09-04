import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type OnyxPlugin from "./main";

export type SavePolicy = "afterDelay" | "onFocusChange" | "manual";
export type ColorScheme = "onyx" | "obsidian";
export type LintTrigger = "manual" | "onSave" | "afterDelay";

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
	/** Run Git commands for gutter and explorer status indicators. */
	gitEnabled: boolean;
	/** Resolve vault-root symlinks whose targets live outside the vault. */
	externalSymlinksEnabled: boolean;
	/**
	 * Per-language-id command override, e.g. `{ "python": ["pyright-langserver",
	 * "--stdio"] }`. Empty entries fall back to auto-detection. Edit in data.json
	 * for now — no settings UI yet.
	 */
	lspServers: Record<string, string[]>;
	/** When configured lint commands run. Manual is always available. */
	lintTrigger: LintTrigger;
	/** Debounce before an `afterDelay` lint run (ms). */
	lintDelayMs: number;
	/** Per-extension linter argv. Commands run directly, without a shell. */
	lintCommands: Record<string, string[]>;
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
	gitEnabled: true,
	externalSymlinksEnabled: false,
	lspServers: {},
	lintTrigger: "manual",
	lintDelayMs: 1000,
	lintCommands: {},
};

function parseLintCommands(value: string): Record<string, string[]> {
	const parsed: unknown = JSON.parse(value);
	if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
		throw new Error("Enter a JSON object.");
	}
	for (const [extension, command] of Object.entries(parsed)) {
		if (!extension.trim() || !Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)) {
			throw new Error("Each extension must map to a non-empty array of strings.");
		}
	}
	return parsed as Record<string, string[]>;
}

function validateLintCommandsJson(value: string): string | void {
	try {
		parseLintCommands(value);
	} catch (error) {
		return error instanceof Error ? error.message : "Invalid command configuration.";
	}
}

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

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Save",
				desc: "When to write edits to disk. After delay autosaves once you stop typing; on focus change saves when you leave the editor; manual saves only on cmd/ctrl-s.",
				control: {
					type: "dropdown",
					key: "savePolicy",
					options: {
						afterDelay: "After delay (autosave)",
						onFocusChange: "On focus change",
						manual: "Manual only",
					},
				},
			},
			{
				name: "Autosave delay",
				desc: "How long after you stop typing an autosave writes. The file shows as unsaved until then.",
				visible: () => this.plugin.settings.savePolicy === "afterDelay",
				control: { type: "slider", key: "autoSaveDelayMs", min: 250, max: 5000, step: 250 },
			},
			{
				name: "Language servers",
				desc: "Connect a language server for supported files — hover, completion, signature help and diagnostics. Onyx looks for the server in the project's virtualenv and node modules, then the system path. Restart Obsidian after changing.",
				control: { type: "toggle", key: "lspEnabled" },
			},
			{
				type: "group",
				heading: "Linting",
				items: [
					{
						name: "Run automatically",
						desc: "Choose when to run the configured command. Lint current file remains available from the command palette in every mode.",
						control: {
							type: "dropdown",
							key: "lintTrigger",
							options: { manual: "Never", onSave: "On save", afterDelay: "After delay" },
						},
					},
					{
						name: "Lint delay",
						desc: "How long after you stop typing to run the linter.",
						visible: () => this.plugin.settings.lintTrigger === "afterDelay",
						control: { type: "slider", key: "lintDelayMs", min: 250, max: 5000, step: 250 },
					},
					{
						name: "Commands by extension",
						desc: "JSON object mapping file extensions to an executable and arguments. Use ${file} and ${workspace} placeholders. Commands run directly, without a shell.",
						control: {
							type: "textarea",
							key: "lintCommandsJson",
							placeholder: '{\n  "ts": ["eslint", "--format", "json", "${file}"]\n}',
							validate: validateLintCommandsJson,
						},
					},
				],
			},
			{
				name: "Git integration",
				desc: "Run Git commands to show gutter and workspace explorer status indicators.",
				control: { type: "toggle", key: "gitEnabled" },
			},
			{
				name: "External symlinks (experimental)",
				desc: "Resolve symlinks in the vault root whose targets are outside the vault. This permits the plugin to inspect paths outside the vault.",
				control: { type: "toggle", key: "externalSymlinksEnabled" },
			},
			{
				type: "group",
				heading: "Appearance",
				items: [
					{
						name: "Colour scheme",
						desc: "Onyx is a curated palette mapped onto Obsidian's colour primitives. Follow Obsidian theme reuses the theme's own code-block colours.",
						control: { type: "dropdown", key: "colorScheme", options: { onyx: "Onyx", obsidian: "Follow Obsidian theme" } },
					},
					{
						name: "Font family",
						desc: "Leave empty to use Obsidian's monospace font.",
						control: { type: "text", key: "fontFamily", placeholder: "Obsidian default" },
					},
					{
						name: "Font size",
						desc: "Size in pixels; 0 inherits Obsidian's editor font size.",
						control: { type: "slider", key: "fontSize", min: 0, max: 24, step: 1 },
					},
					{
						name: "Line height",
						control: { type: "slider", key: "lineHeight", min: 1.1, max: 2, step: 0.05 },
					},
					{
						name: "Ligatures",
						desc: "Programming ligatures, if the font provides them.",
						control: { type: "toggle", key: "ligatures" },
					},
					{
						name: "Sticky scroll",
						desc: "Pin enclosing namespaces, types, and functions at the top of the editor.",
						control: { type: "toggle", key: "stickyScroll" },
					},
					{
						name: "Indentation guides",
						control: { type: "toggle", key: "indentGuides" },
					},
					{
						name: "Highlight active indentation guide",
						desc: "Brighten the guide for the current scope.",
						control: { type: "toggle", key: "activeIndentGuide" },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key === "lintCommandsJson") return JSON.stringify(this.plugin.settings.lintCommands, null, 2);
		return this.plugin.settings[key as keyof OnyxSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "lintCommandsJson") {
			this.plugin.settings.lintCommands = parseLintCommands(String(value));
			await this.commit();
			return;
		}
		const settingKey = key as keyof OnyxSettings;
		if (!(settingKey in this.plugin.settings) || settingKey === "lspServers") return;
		if (settingKey === "fontFamily") value = String(value).trim();
		(this.plugin.settings as unknown as Record<string, unknown>)[settingKey] = value;
		await this.commit();
		this.plugin.applyIntegrationSettings();
		if (settingKey === "savePolicy" || settingKey === "lintTrigger") {
			const update = (this as unknown as Record<string, unknown>)["update"] as (() => void) | undefined;
			update?.call(this);
		}
	}

	// Required as a fallback for Obsidian versions older than 1.13.0.
	display(): void {
		this.renderLegacySettings();
	}

	private renderLegacySettings(): void {
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
						this.renderLegacySettings();
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

		new Setting(containerEl).setName("Linting").setHeading();

		new Setting(containerEl)
			.setName("Run automatically")
			.setDesc("Choose when to run the configured command. Lint current file remains available from the command palette in every mode.")
			.addDropdown((dd) =>
				dd
					.addOption("manual", "Never")
					.addOption("onSave", "On save")
					.addOption("afterDelay", "After delay")
					.setValue(this.plugin.settings.lintTrigger)
					.onChange(async (value) => {
						this.plugin.settings.lintTrigger = value as LintTrigger;
						await this.plugin.saveSettings();
						this.renderLegacySettings();
					}),
			);

		if (this.plugin.settings.lintTrigger === "afterDelay") {
			new Setting(containerEl)
				.setName("Lint delay")
				.setDesc("How long after you stop typing to run the linter.")
				.addSlider((slider) =>
					slider
						.setLimits(250, 5000, 250)
						.setValue(this.plugin.settings.lintDelayMs)
						.onChange(async (value) => {
							this.plugin.settings.lintDelayMs = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Commands by extension")
			.setDesc("JSON object mapping file extensions to an executable and arguments. Use ${file} and ${workspace} placeholders. Commands run directly, without a shell.")
			.addTextArea((text) => {
				text.setPlaceholder('{\n  "ts": ["eslint", "--format", "json", "${file}"]\n}')
					.setValue(JSON.stringify(this.plugin.settings.lintCommands, null, 2))
					.onChange(async (value) => {
						if (validateLintCommandsJson(value)) return;
						this.plugin.settings.lintCommands = parseLintCommands(value);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 6;
			});

		new Setting(containerEl)
			.setName("Git integration")
			.setDesc("Run Git commands to show gutter and workspace explorer status indicators.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.gitEnabled)
					.onChange(async (value) => {
						this.plugin.settings.gitEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.applyIntegrationSettings();
					}),
			);

		new Setting(containerEl)
			.setName("External symlinks (experimental)")
			.setDesc("Resolve symlinks in the vault root whose targets are outside the vault. This permits the plugin to inspect paths outside the vault.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.externalSymlinksEnabled)
					.onChange(async (value) => {
						this.plugin.settings.externalSymlinksEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.applyIntegrationSettings();
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
