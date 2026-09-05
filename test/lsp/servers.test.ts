import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveServer } from "../../src/lsp/servers";

function fakeExe(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

describe("resolveServer", () => {
	let root: string;
	let previousPath: string | undefined;
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "onyx-proj-")));
		previousPath = process.env.PATH;
		process.env.PATH = "";
	});
	afterEach(() => {
		process.env.PATH = previousPath;
		rmSync(root, { recursive: true, force: true });
	});

	it("runs the exact configured argv", () => {
		const executable = join(root, "tools", "lsp");
		fakeExe(executable);
		const result = resolveServer(root, "cpp", [executable, "--stdio"]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.spec.args).toEqual(["--stdio"]);
	});

	it("resolves relative commands from the explicit project root", () => {
		const executable = join(root, "tools", "lsp");
		fakeExe(executable);
		const result = resolveServer(root, "cpp", ["./tools/lsp"]);
		expect(result.ok && result.spec.command).toBe(executable);
	});

	it("uses only the inherited PATH for bare commands", () => {
		const executable = join(root, "path", "nix");
		fakeExe(executable);
		process.env.PATH = join(root, "path");
		const result = resolveServer(root, "cpp", ["nix", "develop", ".", "-c", "clangd"]);
		expect(result.ok && result.spec.command).toBe(executable);
	});

	it("does not guess a server when no command is configured", () => {
		const result = resolveServer(root, "cpp", []);
		expect(result.ok).toBe(false);
	});
});
