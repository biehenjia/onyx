import { describe, expect, it } from "vitest";
import { parseGitStatus } from "../src/git";
import { diffLines } from "../src/git-gutter";

describe("git status", () => {
	it("parses ordinary, renamed, and untracked porcelain v2 records", () => {
		const output = [
			"1 .M N... 100644 100644 100644 abc abc src/a.ts",
			"? new file.ts",
			"2 R. N... 100644 100644 100644 abc def R100 src/new.ts",
			"src/old.ts",
			"",
		].join("\0");
		const status = parseGitStatus(output);
		expect(status.get("src/a.ts")).toBe("modified");
		expect(status.get("new file.ts")).toBe("untracked");
		expect(status.get("src/new.ts")).toBe("renamed");
	});
});

describe("git gutter line diff", () => {
	it("distinguishes additions, deletions, and replacements", () => {
		expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([{ line: 2, kind: "modified" }]);
		expect(diffLines("a\nc", "a\nb\nc")).toEqual([{ line: 2, kind: "added" }]);
		expect(diffLines("a\nb\nc", "a\nc")).toEqual([{ line: 2, kind: "deleted" }]);
	});
});
