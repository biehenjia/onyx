import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, sep } from "path";
import { isUnsafeRoot, resolveProject } from "../../src/lsp/roots";

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
});
