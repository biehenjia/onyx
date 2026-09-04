import { describe, expect, it } from "vitest";
import { fallbackSymbols } from "../src/symbols";

describe("fallback symbols", () => {
	it("finds common declarations without an LSP", () => {
		const symbols = fallbackSymbols([
			"export class Greeter {}",
			"async function hello() {}",
			"def python_name():",
			"    pass",
			"const ordinaryValue = 1",
		].join("\n"));

		expect(symbols.map((symbol) => symbol.name)).toEqual([
			"Greeter",
			"hello",
			"python_name",
		]);
	});

	it("records the declaration name offset", () => {
		const text = "// heading\nfunction target() {}";
		expect(fallbackSymbols(text)[0].from).toBe(text.indexOf("target"));
	});
});
