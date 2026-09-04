import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { stickyHeaders, stickyHeadersBelowViewport } from "../src/sticky-scroll";

describe("stickyHeaders", () => {
	it("stacks enclosing TypeScript namespace, class, and method", () => {
		const doc = [
			"namespace Tools {",
			"  class Worker {",
			"    run(value: number) {",
			"      return value;",
			"    }",
			"  }",
			"}",
		].join("\n");
		const state = EditorState.create({
			doc,
			extensions: [javascript({ typescript: true })],
		});

		expect(stickyHeaders(state, doc.indexOf("return"), "typescript")).toEqual([
			{ from: 0, text: "namespace Tools {" },
			{ from: doc.indexOf("  class"), text: "  class Worker {" },
			{ from: doc.indexOf("    run"), text: "    run(value: number) {" },
		]);
	});

	it("pins Python classes and functions but not control-flow blocks", () => {
		const doc = [
			"class Worker:",
			"    def run(value):",
			"        if value:",
			"            return value",
		].join("\n");
		const state = EditorState.create({ doc, extensions: [python()] });

		expect(stickyHeaders(state, doc.indexOf("return"), "python").map((h) => h.text)).toEqual([
			"class Worker:",
			"    def run(value):",
		]);
	});

	it("does nothing for languages without a scope profile", () => {
		const state = EditorState.create({ doc: "one\ntwo" });
		expect(stickyHeaders(state, 4, "text")).toEqual([]);
	});

	it("advances the scope probe below each nested sticky row", () => {
		const lines = [
			"function outer() {",
			"  function inner() {",
			"    const first = true;",
			"    const second = first;",
			"    return second;",
			"  }",
			"}",
		];
		const state = EditorState.create({
			doc: lines.join("\n"),
			extensions: [javascript()],
		});
		const lineStarts = lines.map((_, index) => state.doc.line(index + 1).from);
		const headers = stickyHeadersBelowViewport(
			state,
			"javascript",
			20,
			20,
			(height) => lineStarts[Math.min(Math.floor(height / 20), lines.length - 1)],
		);

		expect(headers.map((header) => header.text)).toEqual([
			"function outer() {",
			"  function inner() {",
		]);
	});

	it("pins a nested scope as its declaration reaches an existing sticky row", () => {
		const lines = [
			"function outer() {",
			"  const before = true;",
			"  function inner() {",
			"    return before;",
			"  }",
			"}",
		];
		const state = EditorState.create({
			doc: lines.join("\n"),
			extensions: [javascript()],
		});
		const lineStarts = lines.map((_, index) => state.doc.line(index + 1).from);
		const headers = stickyHeadersBelowViewport(
			state,
			"javascript",
			20,
			20,
			(height) => lineStarts[Math.min(Math.floor(height / 20), lines.length - 1)],
		);

		expect(headers.map((header) => header.text)).toEqual([
			"function outer() {",
			"  function inner() {",
		]);
	});
});
