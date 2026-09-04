import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		setupFiles: ["test/setup.ts"],
	},
	resolve: {
		alias: {
			// src files import from "obsidian" for types and a few runtime
			// helpers; tests get a hand-rolled stub instead of the real plugin API.
			obsidian: resolve(import.meta.dirname, "test/mocks/obsidian.ts"),
		},
	},
});
