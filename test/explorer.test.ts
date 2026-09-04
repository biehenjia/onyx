import { describe, expect, it } from "vitest";
import { isWorkspaceItemVisible } from "../src/explorer";

describe("workspace explorer visibility", () => {
	it.each(["node_modules", ".git", ".direnv", ".venv", "target", "dist", "build", "__pycache__"])(
		"hides generated or internal directory %s",
		(name) => expect(isWorkspaceItemVisible(name, true)).toBe(false),
	);

	it.each([
		["logo.png", "png"],
		["archive.zip", "zip"],
		["program.exe", "exe"],
		["cache.pyc", "pyc"],
		[".DS_Store", ""],
	] as const)("hides binary or metadata file %s", (name, extension) => {
		expect(isWorkspaceItemVisible(name, false, extension)).toBe(false);
	});

	it.each([
		[".env", ""],
		[".gitignore", ""],
		["main.ts", "ts"],
		["Cargo.lock", "lock"],
		["README.md", "md"],
	] as const)("keeps useful project file %s", (name, extension) => {
		expect(isWorkspaceItemVisible(name, false, extension)).toBe(true);
	});

	it("keeps useful dot-directories", () => {
		expect(isWorkspaceItemVisible(".github", true)).toBe(true);
	});
});
