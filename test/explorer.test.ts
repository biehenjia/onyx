import { describe, expect, it } from "vitest";
import {
	getMoveDestination,
	isWorkspaceItemVisible,
	workspaceRootForPath,
	workspaceRootPaths,
} from "../src/explorer";

describe("workspace selection", () => {
	const files = [
		{ name: "onyx.toml", path: "linked-api/onyx.toml" },
		{ name: "onyx.toml", path: "linked-api/packages/site/onyx.toml" },
		{ name: "onyx.toml", path: "onyx.toml" },
		{ name: "package.json", path: "linked-web/package.json" },
	];

	it("finds only folders marked by a direct onyx.toml", () => {
		expect(workspaceRootPaths(files)).toEqual([
			"",
			"linked-api",
			"linked-api/packages/site",
		]);
	});

	it("resolves a file to its nearest marked workspace", () => {
		const roots = workspaceRootPaths(files);
		expect(workspaceRootForPath("linked-api/src/server.ts", roots)).toBe("linked-api");
		expect(workspaceRootForPath("linked-api/packages/site/src/page.ts", roots))
			.toBe("linked-api/packages/site");
		expect(workspaceRootForPath("unrelated/file.ts", roots)).toBe("");
	});

	it("does not resolve a path without a containing marked workspace", () => {
		expect(workspaceRootForPath("unrelated/file.ts", ["linked-api"])).toBeNull();
	});
});

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

describe("workspace explorer moves", () => {
	it("moves an item into a folder while preserving its name", () => {
		expect(getMoveDestination("src/main.ts", false, "archive", false))
			.toEqual({ path: "archive/main.ts" });
	});

	it("moves an item back to the workspace root", () => {
		expect(getMoveDestination("src/main.ts", false, "", false))
			.toEqual({ path: "main.ts" });
	});

	it("rejects moves into the same parent", () => {
		expect(getMoveDestination("src/main.ts", false, "src", true))
			.toEqual({ error: "The item is already in that folder." });
	});

	it("rejects moving a folder into itself or a descendant", () => {
		expect(getMoveDestination("src", true, "src", false)).toHaveProperty("error");
		expect(getMoveDestination("src", true, "src/nested", false)).toHaveProperty("error");
	});

	it("rejects destination name collisions", () => {
		expect(getMoveDestination("src/main.ts", false, "archive", true))
			.toEqual({ error: "An item named “main.ts” already exists in that folder." });
	});
});
