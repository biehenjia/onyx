import { describe, expect, it } from "vitest";
import { languageByName } from "../src/languages";
import { lspIdToLanguageTag } from "../src/lsp/hover-highlight";

describe("languageByName", () => {
	it("maps the names servers fence with", () => {
		expect(languageByName("typescript")?.name).toBe("typescript");
		expect(languageByName("ts")?.name).toBe("typescript");
		expect(languageByName("tsx")?.name).toBe("typescript");
		expect(languageByName("javascript")?.name).toBe("javascript");
		expect(languageByName("python")?.name).toBe("python");
		expect(languageByName("py")?.name).toBe("python");
		expect(languageByName("rust")?.name).toBe("rust");
		expect(languageByName("rs")?.name).toBe("rust");
		expect(languageByName("go")?.name).toBe("go");
		expect(languageByName("golang")?.name).toBe("go");
		expect(languageByName("c++")?.name).toBe("cpp");
		expect(languageByName("cpp")?.name).toBe("cpp");
		expect(languageByName("json")?.name).toBe("json");
		expect(languageByName("yaml")?.name).toBe("yaml");
	});

	it("is case- and whitespace-insensitive", () => {
		expect(languageByName("PYTHON")?.name).toBe("python");
		expect(languageByName("  Go  ")?.name).toBe("go");
	});

	it("returns null for empty or unknown tags", () => {
		expect(languageByName("")).toBeNull();
		expect(languageByName("   ")).toBeNull();
		expect(languageByName("cobol")).toBeNull();
		expect(languageByName("brainfuck")).toBeNull();
	});

	it("returns a parseable Language, cached per tag", () => {
		const a = languageByName("go");
		const b = languageByName("go");
		expect(a).toBe(b); // memoised
		expect(typeof a?.parser?.parse).toBe("function");
	});
});

describe("lspIdToLanguageTag", () => {
	it("maps the react language ids to jsx/tsx", () => {
		expect(lspIdToLanguageTag("typescriptreact")).toBe("tsx");
		expect(lspIdToLanguageTag("javascriptreact")).toBe("jsx");
	});

	it("passes every other id straight through to languageByName", () => {
		for (const id of ["cpp", "c", "python", "rust", "go", "typescript"]) {
			expect(lspIdToLanguageTag(id)).toBe(id);
			expect(languageByName(lspIdToLanguageTag(id))).not.toBeNull();
		}
	});
});
