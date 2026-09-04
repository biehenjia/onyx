import { existsSync, readdirSync, realpathSync } from "fs";
import { dirname, join, parse as parsePath, sep } from "path";
import { pathToFileURL } from "url";
import { homedir } from "os";

/**
 * Files marking a project root, checked as we walk up the directory tree. Order
 * within a directory doesn't matter — the first ancestor that has *any* of these
 * wins. VCS dirs are last-resort; a build/package manifest is a tighter root
 * (matters for monorepos, where `.git` is far above the actual project).
 */
const ROOT_MARKERS = [
	"compile_commands.json",
	"CMakeLists.txt",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"Cargo.toml",
	"go.mod",
	"package.json",
	"flake.nix",
	".git",
	".hg",
	".svn",
];

export interface ProjectPaths {
	/** Canonical absolute path to the file, with every symlink resolved. */
	realFile: string;
	/** Canonical absolute path to the project root. */
	realRoot: string;
	/** `file://` URI for `realFile`. */
	fileUri: string;
	/** `file://` URI for `realRoot`. */
	rootUri: string;
}

function withSep(p: string): string {
	return p.endsWith(sep) ? p : p + sep;
}

/**
 * A root we must never hand to a project-indexing language server
 * (`clangd --background-index`, `gopls`, …): `$HOME` itself or any ancestor of
 * it. Rooted there, the server tries to crawl the entire home directory.
 */
export function isUnsafeRoot(root: string): boolean {
	const home = homedir();
	if (!home) return false;
	return withSep(home).startsWith(withSep(root));
}

/**
 * Resolve an absolute on-disk path to its project root.
 *
 * `absFile` is expected to be a real filesystem path (e.g. from Obsidian's
 * `FileSystemAdapter.getFullPath`). We `realpathSync` it first so that when the
 * vault reaches a repo through a symlink (`~/OE/foo-<hash>` -> `~/foo`), we walk
 * up from the *real* location and hand the server real paths throughout — no
 * URI translation shim needed.
 *
 * Returns `null` if the path doesn't exist on disk.
 */
export function resolveProject(absFile: string): ProjectPaths | null {
	let realFile: string;
	try {
		realFile = realpathSync(absFile);
	} catch {
		return null;
	}

	const stop = new Set([parsePath(realFile).root, homedir()]);
	let dir = dirname(realFile);
	let root = dir; // fallback: the file's own directory
	let foundMarker = false;

	for (;;) {
		if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) {
			root = dir;
			foundMarker = true;
			break;
		}
		if (stop.has(dir)) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	// Never root a server at $HOME or above — it would index the whole home dir.
	if (isUnsafeRoot(root)) return null;
	// A loose file in an immediate subdirectory of $HOME with no project marker
	// (`~/Desktop/scratch.py`) isn't a project; don't stand up an indexing
	// server scoped to `~/Desktop`. A real marker there (`~/src/.git`) is fine.
	if (!foundMarker && dirname(root) === homedir()) return null;

	return {
		realFile,
		realRoot: root,
		fileUri: pathToFileURL(realFile).href,
		rootUri: pathToFileURL(root).href,
	};
}

interface VaultLink {
	/** Canonical target path of the symlink, with a trailing separator. */
	realPrefix: string;
	/** The symlink's name inside the vault, i.e. its vault-relative dir. */
	vaultDir: string;
}

/**
 * Reverse lookup: real on-disk path -> vault-relative path.
 *
 * The plain case is a prefix strip against the (symlink-resolved) vault root.
 * The interesting case is an out-of-tree repo linked into the vault
 * (`~/OE/foo-<hash>` -> `~/foo`, per NOTES.md): a language server rooted at the
 * repo's real path hands back real-path URIs like `~/foo/src/x.cpp`, which live
 * *inside* the vault only via the symlink. We scan the vault root for such links
 * once so those targets can still be opened as real `TFile`s.
 */
export class VaultMap {
	private readonly base: string;
	private links: VaultLink[] = [];

	constructor(vaultBase: string) {
		this.base = vaultBase.endsWith(sep) ? vaultBase : vaultBase + sep;
		this.refresh();
	}

	/** Re-scan the vault root for symlinks (call when the link set changes). */
	refresh(): void {
		const links: VaultLink[] = [];
		try {
			for (const entry of readdirSync(this.base, { withFileTypes: true })) {
				if (!entry.isSymbolicLink()) continue;
				try {
					const real = realpathSync(join(this.base, entry.name));
					links.push({
						realPrefix: real.endsWith(sep) ? real : real + sep,
						vaultDir: entry.name,
					});
				} catch {
					// dangling link
				}
			}
		} catch {
			// vault root unreadable
		}
		this.links = links;
	}

	/**
	 * Map an absolute path to a vault-relative path (`/`-separated), or `null`
	 * when it isn't reachable inside the vault by any route.
	 */
	toVaultPath(absPath: string): string | null {
		let real: string;
		try {
			real = realpathSync(absPath);
		} catch {
			real = absPath;
		}

		if (real.startsWith(this.base)) {
			return real.slice(this.base.length).split(sep).join("/");
		}
		for (const { realPrefix, vaultDir } of this.links) {
			if (!real.startsWith(realPrefix)) continue;
			const rest = real.slice(realPrefix.length).split(sep).join("/");
			return rest ? `${vaultDir}/${rest}` : vaultDir;
		}
		return null;
	}
}
