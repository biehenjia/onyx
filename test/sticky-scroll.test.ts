import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { stickyHeaders } from "../src/sticky-scroll";

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
});
