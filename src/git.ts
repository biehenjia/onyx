import { execFile } from "child_process";
import { realpathSync } from "fs";
import { dirname, relative, resolve, sep } from "path";

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

function runGit(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolveRun, reject) => {
		execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error instanceof Error ? error : new Error("Git command failed", { cause: error }));
			else resolveRun(stdout);
		});
	});
}

export function parseGitStatus(output: string): Map<string, GitFileStatus> {
	const result = new Map<string, GitFileStatus>();
	const fields = output.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i];
		if (!entry) continue;
		if (entry.startsWith("? ")) {
			result.set(entry.slice(2), "untracked");
			continue;
		}
		if (entry.startsWith("u ")) {
			result.set(entry.split(" ").slice(10).join(" "), "conflicted");
			continue;
		}
		if (!entry.startsWith("1 ") && !entry.startsWith("2 ")) continue;
		const parts = entry.split(" ");
		const xy = parts[1];
		const path = parts.slice(entry.startsWith("2 ") ? 9 : 8).join(" ");
		const code = `${xy[0]}${xy[1]}`;
		let status: GitFileStatus = "modified";
		if (code.includes("A")) status = "added";
		else if (code.includes("D")) status = "deleted";
		else if (code.includes("R") || entry.startsWith("2 ")) status = "renamed";
		result.set(path, status);
		if (entry.startsWith("2 ")) i++; // porcelain v2 emits the original path next
	}
	return result;
}

export class GitService {
	private roots = new Map<string, Promise<string | null>>();

	private rootFor(fullPath: string): Promise<string | null> {
		let dir = dirname(fullPath);
		try {
			dir = realpathSync(dir);
		} catch {
			// A deleted path may no longer resolve; Git can still inspect its parent.
		}
		let pending = this.roots.get(dir);
		if (!pending) {
			pending = runGit(dir, ["rev-parse", "--show-toplevel"])
				.then((root) => resolve(root.trim()))
				.catch(() => null);
			this.roots.set(dir, pending);
		}
		return pending;
	}

	async headText(fullPath: string): Promise<string | null> {
		const root = await this.rootFor(fullPath);
		if (!root) return null;
		let realFile = fullPath;
		try {
			realFile = realpathSync(fullPath);
		} catch {
			// Keep the lexical path for a file that disappeared between load and diff.
		}
		const repoPath = relative(root, realFile).split(sep).join("/");
		try {
			return await runGit(root, ["show", `HEAD:${repoPath}`]);
		} catch {
			// A file inside a repository but absent from HEAD is untracked/added.
			return "";
		}
	}

	async statusFor(fullPath: string): Promise<{ root: string; files: Map<string, GitFileStatus> } | null> {
		const root = await this.rootFor(fullPath);
		if (!root) return null;
		try {
			return { root, files: parseGitStatus(await runGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])) };
		} catch {
			return null;
		}
	}
}
