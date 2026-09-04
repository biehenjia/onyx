import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	{
		ignores: ["main.js", "node_modules/", "*.mjs", "version-bump.mjs"],
	},
	...tseslint.configs.recommended,
	// eslint-plugin-obsidianmd ships a flat "recommended" config that enables the
	// community-review ruleset (detached leaves, innerHTML, Vault.modify vs
	// process, missing onunload cleanup, casting app to any, etc.). Some of its
	// rules are type-aware, so the parser needs project info.
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
);
