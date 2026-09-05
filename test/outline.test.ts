import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { describe, expect, it } from "vitest";
import {
	currentFunction,
	functionDeclarations,
	outlineEntries,
	scopeChain,
} from "../src/outline";

describe("function outline", () => {
	it("lists declarations in source order, including nested functions", () => {
		const text = [
			"function first() {",
			"  function nested() {}",
			"}",
			"class Example { method() {} }",
			"const handler = () => {};",
		].join("\n");
		const state = EditorState.create({ doc: text, extensions: [javascript()] });

		expect(functionDeclarations(state, "javascript").map((entry) => entry.name))
			.toEqual(["first", "nested", "method", "handler"]);
	});

	it("uses the innermost function for a selected position", () => {
		const text = "function outer() {\n  function inner() { return 1; }\n}";
		const state = EditorState.create({ doc: text, extensions: [javascript()] });

		expect(currentFunction(state, text.indexOf("return"), "javascript")?.name)
			.toBe("inner");
	});

	it("nests namespaces, classes, and functions and exposes their scope chain", () => {
		const text = [
			"namespace App {",
			"  class Greeter {",
			"    greet() { return 'hello'; }",
			"  }",
			"}",
		].join("\n");
		const state = EditorState.create({
			doc: text,
			extensions: [javascript({ typescript: true })],
		});
		const outline = outlineEntries(state, "typescript");

		expect(outline.map((entry) => entry.name)).toEqual(["App"]);
		expect(outline[0].children.map((entry) => entry.name)).toEqual(["Greeter"]);
		expect(outline[0].children[0].children.map((entry) => entry.name)).toEqual(["greet"]);
		expect(scopeChain(state, text.indexOf("return"), "typescript").map((entry) => entry.name))
			.toEqual(["App", "Greeter", "greet"]);
	});
});
