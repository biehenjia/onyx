import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, sep } from "path";
import { isUnsafeRoot, resolveProject, VaultMap } from "../../src/lsp/roots";
import { resolveLspSetup } from "../../src/lsp/setup";

describe("isUnsafeRoot", () => {
	const HOME = process.env.HOME ?? "/home/nobody";

	it("rejects $HOME itself", () => {
		expect(isUnsafeRoot(HOME)).toBe(true);
		expect(isUnsafeRoot(HOME + sep)).toBe(true);
	});

	it("rejects any ancestor of $HOME", () => {
		expect(isUnsafeRoot(dirname(HOME))).toBe(true);
		expect(isUnsafeRoot("/")).toBe(true);
	});

	it("allows real project dirs under $HOME", () => {
		expect(isUnsafeRoot(join(HOME, "projects"))).toBe(false);
		expect(isUnsafeRoot(join(HOME, "projects", "onyx"))).toBe(false);
	});
});

describe("resolveProject", () => {
	let home: string;
	let prevHome: string | undefined;

	beforeEach(() => {
		prevHome = process.env.HOME;
		home = realpathSync(mkdtempSync(join(tmpdir(), "onyx-home-")));
		process.env.HOME = home;
	});
	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(home, { recursive: true, force: true });
	});

	it("roots at the nearest marker directory", () => {
		const proj = join(home, "code", "repo");
		mkdirSync(join(proj, "src"), { recursive: true });
		mkdirSync(join(proj, ".git"));
		const file = join(proj, "src", "a.ts");
		writeFileSync(file, "export {}\n");

		const res = resolveProject(file);
		expect(res?.realRoot).toBe(proj);
		expect(res?.realFile).toBe(file);
		expect(res?.rootUri).toMatch(/^file:\/\//);
	});

	it("refuses a file sitting directly in $HOME", () => {
		const file = join(home, "scratch.py");
		writeFileSync(file, "print(1)\n");
		expect(resolveProject(file)).toBeNull();
	});

	it("refuses a marker-less loose file one level under $HOME", () => {
		const dir = join(home, "Desktop");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "scratch.py");
		writeFileSync(file, "print(1)\n");
		expect(resolveProject(file)).toBeNull();
	});

	it("still roots a real project one level under $HOME", () => {
		const proj = join(home, "repo");
		mkdirSync(join(proj), { recursive: true });
		mkdirSync(join(proj, ".git"));
		const file = join(proj, "main.go");
		writeFileSync(file, "package main\n");
		expect(resolveProject(file)?.realRoot).toBe(proj);
	});

	it("returns null for a path that does not exist", () => {
		expect(resolveProject(join(home, "nope", "missing.ts"))).toBeNull();
	});

	it("builds one fully canonical setup for a file reached through a symlink", () => {
		const proj = join(home, "repo");
		const vault = join(home, "vault");
		mkdirSync(join(proj, "src"), { recursive: true });
		mkdirSync(vault);
		writeFileSync(join(proj, "onyx.toml"), [
			'name = "Linked project"',
			"[lsp.typescript]",
			'command = ["nix", "develop", ".", "-c", "typescript-language-server", "--stdio"]',
			"",
		].join("\n"));
		const realFile = join(proj, "src", "index.ts");
		writeFileSync(realFile, "export {}\n");
		symlinkSync(proj, join(vault, "linked"));

		const setup = resolveLspSetup(join(vault, "linked", "src", "index.ts"), "typescript");
		expect(setup?.realFile).toBe(realFile);
		expect(setup?.realRoot).toBe(proj);
		expect(setup?.fileUri).not.toContain("linked");
		expect(setup?.key).toBe(`${proj}\0typescript`);
		expect(setup?.command.at(-1)).toBe("--stdio");
	});
});

describe("VaultMap external symlinks", () => {
	it("only maps out-of-vault targets after the experimental option is enabled", () => {
		const root = mkdtempSync(join(tmpdir(), "onyx-vault-map-"));
		try {
			const vault = join(root, "vault");
			const external = join(root, "external");
			mkdirSync(vault);
			mkdirSync(external);
			const file = join(external, "source.ts");
			writeFileSync(file, "export {}\n");
			symlinkSync(external, join(vault, "linked-project"));

			const map = new VaultMap(vault, false);
			expect(map.toVaultPath(file)).toBeNull();
			map.setExternalLinksEnabled(true);
			expect(map.toVaultPath(file)).toBe("linked-project/source.ts");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
