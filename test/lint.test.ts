import { describe, expect, it } from "vitest";
import { parseLintOutput } from "../src/lint";

describe("lint output", () => {
	it("parses ESLint JSON", () => {
		const issues = parseLintOutput(JSON.stringify([{ messages: [{
			line: 2, column: 4, endLine: 2, endColumn: 7,
			severity: 2, message: "Unexpected any", ruleId: "no-explicit-any",
		}] }]));
		expect(issues).toEqual([{
			line: 2, column: 4, endLine: 2, endColumn: 7,
			severity: "error", message: "Unexpected any", source: "no-explicit-any",
		}]);
	});

	it("parses compiler and errfmt-style lines", () => {
		expect(parseLintOutput("/tmp/a.nix:3:8: warning: unused binding"))
			.toEqual([{ line: 3, column: 8, severity: "warning", message: "unused binding" }]);
	});

	it("accepts an empty JSON result", () => {
		expect(parseLintOutput("[]")).toEqual([]);
	});
});
