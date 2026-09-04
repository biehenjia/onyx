import { describe, expect, it } from "vitest";
import { newFilePath, parentPath } from "../src/new-file";

describe("new source file paths", () => {
	it("defaults beside the active file", () => {
		expect(parentPath("projects/onyx/src/main.ts")).toBe("projects/onyx/src");
		expect(parentPath("main.ts")).toBe("");
	});

	it("normalizes a vault-relative source path", () => {
		expect(newFilePath(" src\\tools\\build.py ")).toBe("src/tools/build.py");
	});

	it.each(["", "src/", "README", "/tmp/file.ts", "../file.ts", "notes.md"])(
		"rejects %s",
		(input) => expect(() => newFilePath(input)).toThrow(),
	);

	it("allows dotfiles", () => {
		expect(newFilePath(".env")).toBe(".env");
	});
});
