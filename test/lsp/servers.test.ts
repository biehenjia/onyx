import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter as pathDelimiter, join } from "path";
import { resolveServer } from "../../src/lsp/servers";

function fakeExe(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

describe("resolveServer", () => {
	let root: string;
	let prevPath: string | undefined;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "onyx-proj-")));
		prevPath = process.env.PATH;
		// Keep system dirs off the search so "not found" cases are deterministic;
		// EXTRA_BIN_DIRS are absolute and unlikely to hold these names.
		process.env.PATH = "";
	});
	afterEach(() => {
		process.env.PATH = prevPath;
		rmSync(root, { recursive: true, force: true });
	});

	it("reports a reason for a language it knows no server for", () => {
		const res = resolveServer(root, "cobol", {});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/no known language server for cobol/);
	});

	it("reports a reason when a configured override cannot be found", () => {
		const res = resolveServer(root, "python", {
			python: ["totally-bogus-lsp-xyz", "--stdio"],
		});
		expect(res.ok).toBe(false);
		if (!res.ok)
			expect(res.reason).toMatch(
				/configured python language server "totally-bogus-lsp-xyz" was not found/,
			);
	});

	it("reports which binaries it looked for when auto-detect finds nothing", () => {
		// Use a name not plausibly installed in EXTRA_BIN_DIRS on a dev box.
		const res = resolveServer(root, "go", {});
		if (!res.ok) {
			expect(res.reason).toMatch(/no go language server found/);
			expect(res.reason).toMatch(/gopls/);
		} else {
			// gopls really is installed here; nothing to assert about failure.
			expect(res.spec.command).toMatch(/gopls/);
		}
	});

	it("finds a project-local server under .venv/bin and prepends project bins to PATH", () => {
		const bin = join(root, ".venv", "bin", "pyright-langserver");
		fakeExe(bin);

		const res = resolveServer(root, "python", {});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.spec.command).toBe(bin);
		expect(res.spec.args).toEqual(["--stdio"]);
		expect(res.spec.cwd).toBe(root);
		expect(res.spec.env.PATH?.split(pathDelimiter)[0]).toBe(
			join(root, ".venv", "bin"),
		);
	});

	it("resolves a bare override against project bin dirs", () => {
		const bin = join(root, "node_modules", ".bin", "mylsp");
		fakeExe(bin);

		const res = resolveServer(root, "typescript", {
			typescript: ["mylsp", "--stdio"],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.spec.command).toBe(bin);
		expect(res.spec.args).toEqual(["--stdio"]);
	});

	it("takes an absolute override as-is", () => {
		const res = resolveServer(root, "rust", {
			rust: ["/opt/custom/ra", "--foo"],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.spec.command).toBe("/opt/custom/ra");
		expect(res.spec.args).toEqual(["--foo"]);
	});
});
