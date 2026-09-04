import {
	hoverTooltips,
	LSPClient,
	serverCompletion,
	serverDiagnostics,
	signatureHelp,
	Workspace,
} from "@codemirror/lsp-client";
import { ClosureInfo, StdioTransport } from "./transport";
import { resolveServer } from "./servers";
import { languageByName } from "../languages";

/** Lifecycle of a `(projectRoot × languageId)` server, surfaced to the UI (C1). */
export type ServerStatus = "starting" | "running" | "crashed" | "absent";

export interface ServerState {
	key: string;
	realRoot: string;
	languageId: string;
	status: ServerStatus;
	/** Why, for `absent` / `crashed` / a transitional `starting` after a crash. */
	detail: string | null;
}

type Listener = (state: ServerState) => void;

interface Entry {
	key: string;
	realRoot: string;
	languageId: string;
	rootUri: string;
	client: LSPClient | null;
	transport: StdioTransport | null;
	refs: number;
	idleTimer: number | null;
	/** Backoff timer scheduled after an unexpected exit. */
	restartTimer: number | null;
	/** Auto-restart attempts since the server was last healthy. */
	restarts: number;
	/** Fires once the server has stayed up long enough to reset `restarts`. */
	stableTimer: number | null;
	/** Crashed past the retry cap (or never resolvable): a manual-restart tombstone. */
	dead: boolean;
}

const IDLE_SHUTDOWN_MS = 5 * 60_000;
const MAX_AUTO_RESTARTS = 3;
const RESTART_BACKOFF_MS = [500, 2_000, 5_000];
const STABLE_AFTER_MS = 60_000;

/**
 * One language server per `${realProjectRoot}\0${languageId}`, shared by every
 * editor that resolves to that pair. Reference-counted: the server starts on the
 * first {@link acquire} and stops on an idle timeout after the last
 * {@link release} (or immediately on {@link disposeAll} at plugin unload).
 *
 * An unexpected exit is not the end: the entry is kept, the server is
 * auto-restarted with backoff up to {@link MAX_AUTO_RESTARTS} times, and every
 * lifecycle change is pushed to {@link onChange} subscribers so sessions can
 * re-bind and the status bar can report. Past the cap the entry becomes a
 * tombstone that the "Restart language server" command can revive.
 */
export class LspRegistry {
	private readonly entries = new Map<string, Entry>();
	private readonly listeners = new Set<Listener>();

	constructor(
		private readonly getOverrides: () => Record<string, string[]>,
		/** Sanitise + syntax-highlight an LSP doc HTML string for a given
		 *  language id (hover / signature / completion). */
		private readonly sanitizeDoc: (
			html: string,
			languageId: string,
		) => string,
		/** Builds the workspace that resolves cross-file jumps; when omitted,
		 *  lsp-client's default (no cross-file navigation) is used. */
		private readonly createWorkspace?: (client: LSPClient) => Workspace,
	) {}

	static keyFor(realRoot: string, languageId: string): string {
		return `${realRoot}\0${languageId}`;
	}

	/** Subscribe to server lifecycle changes; returns an unsubscribe function. */
	onChange(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Get (starting if needed) the client for a project/language pair, or `null`
	 * when no server binary can be found. Every successful call must be paired
	 * with a {@link release}.
	 */
	acquire(
		realRoot: string,
		rootUri: string,
		languageId: string,
	): LSPClient | null {
		const key = LspRegistry.keyFor(realRoot, languageId);
		let entry = this.entries.get(key);

		if (!entry) {
			entry = {
				key,
				realRoot,
				languageId,
				rootUri,
				client: null,
				transport: null,
				refs: 0,
				idleTimer: null,
				restartTimer: null,
				restarts: 0,
				stableTimer: null,
				dead: false,
			};
			this.entries.set(key, entry);
			// On failure the entry is kept as a `dead` tombstone (no refs, no
			// timers): cheap, and it lets "Restart language server" or simply
			// reopening the file re-resolve once a binary is installed.
			if (!this.startProcess(entry)) return null;
		} else if (entry.dead) {
			// Revive a crash tombstone: a fresh editor wants this server again.
			this.clearTimers(entry);
			entry.restarts = 0;
			entry.rootUri = rootUri;
			if (!this.startProcess(entry)) return null;
		}

		entry.refs++;
		if (entry.idleTimer !== null) {
			window.clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		return entry.client;
	}

	/** Current live client for a pair without touching the refcount (for re-bind). */
	clientFor(realRoot: string, languageId: string): LSPClient | null {
		const entry = this.entries.get(LspRegistry.keyFor(realRoot, languageId));
		return entry && !entry.dead ? entry.client : null;
	}

	release(realRoot: string, languageId: string): void {
		const key = LspRegistry.keyFor(realRoot, languageId);
		const entry = this.entries.get(key);
		if (!entry) return;

		entry.refs = Math.max(0, entry.refs - 1);
		if (entry.refs === 0 && entry.idleTimer === null) {
			entry.idleTimer = window.setTimeout(
				() => this.drop(key),
				IDLE_SHUTDOWN_MS,
			);
		}
	}

	/** Force a fresh server for a pair (the "Restart language server" command). */
	restart(realRoot: string, languageId: string): void {
		const key = LspRegistry.keyFor(realRoot, languageId);
		const entry = this.entries.get(key);
		if (!entry) {
			// No entry at all (server was idle-dropped): nothing to reattach.
			// The next acquire() — e.g. reopening the file — starts it fresh.
			console.debug("Onyx: restart requested for a server with no entry", key);
			return;
		}
		this.clearTimers(entry);
		entry.restarts = 0;
		this.teardownProcess(entry);
		this.startProcess(entry);
	}

	disposeAll(): void {
		for (const key of [...this.entries.keys()]) this.drop(key);
		this.listeners.clear();
	}

	// --- internals ----------------------------------------------------------

	private buildClient(rootUri: string, languageId: string): LSPClient {
		return new LSPClient({
			rootUri,
			sanitizeHTML: (html) => this.sanitizeDoc(html, languageId),
			// Highlight fenced code in hover / signature / completion docs with
			// the editor's own HighlightStyle (lsp-client does the rendering).
			highlightLanguage: languageByName,
			workspace: this.createWorkspace,
			extensions: [
				hoverTooltips(),
				serverCompletion(),
				signatureHelp(),
				serverDiagnostics(),
			],
		});
	}

	/**
	 * Resolve and spawn the server into `entry`, wiring the closure handler and
	 * status transitions. Returns the client, or `null` (marking the entry
	 * `dead`) when no server binary resolves.
	 */
	private startProcess(entry: Entry): LSPClient | null {
		const res = resolveServer(
			entry.realRoot,
			entry.languageId,
			this.getOverrides(),
		);
		if (!res.ok) {
			entry.dead = true;
			entry.client = null;
			entry.transport = null;
			this.setStatus(entry, "absent", res.reason);
			return null;
		}

		const client = this.buildClient(entry.rootUri, entry.languageId);
		const transport = new StdioTransport(res.spec, (info) =>
			this.handleClosure(entry.key, info),
		);
		client.connect(transport);
		entry.client = client;
		entry.transport = transport;
		entry.dead = false;
		this.setStatus(entry, "starting", null);

		void client.initializing
			.then(() => {
				if (this.entries.get(entry.key) !== entry) return;
				if (entry.client !== client) return; // superseded by a restart
				this.setStatus(entry, "running", null);
				entry.stableTimer = window.setTimeout(() => {
					entry.restarts = 0;
					entry.stableTimer = null;
				}, STABLE_AFTER_MS);
			})
			.catch(() => {
				// The transport closure handler drives the crash/restart path.
			});

		return client;
	}

	private handleClosure(key: string, info: ClosureInfo): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		if (entry.stableTimer !== null) {
			window.clearTimeout(entry.stableTimer);
			entry.stableTimer = null;
		}
		const reason = info.reason ?? "language server stopped";

		// Nothing holds this server anymore — an expected shutdown.
		if (entry.refs === 0) {
			this.drop(key);
			return;
		}

		if (entry.restarts >= MAX_AUTO_RESTARTS) {
			entry.dead = true;
			entry.client = null;
			entry.transport = null;
			this.setStatus(
				entry,
				"crashed",
				`${reason}; gave up after ${entry.restarts} restarts — run "Restart language server" to retry`,
			);
			return;
		}

		const delay =
			RESTART_BACKOFF_MS[entry.restarts] ??
			RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
		entry.restarts++;
		this.setStatus(
			entry,
			"starting",
			`${reason}; restarting (attempt ${entry.restarts}/${MAX_AUTO_RESTARTS})`,
		);
		entry.restartTimer = window.setTimeout(() => {
			entry.restartTimer = null;
			if (this.entries.get(key) === entry && entry.refs > 0) {
				this.startProcess(entry);
			}
		}, delay);
	}

	/** Disconnect the client and kill the child, leaving the entry in place. */
	private teardownProcess(entry: Entry): void {
		try {
			entry.client?.disconnect();
		} catch {
			/* transport may already be dead */
		}
		entry.transport?.dispose();
		entry.client = null;
		entry.transport = null;
	}

	private clearTimers(entry: Entry): void {
		for (const t of [
			entry.idleTimer,
			entry.restartTimer,
			entry.stableTimer,
		]) {
			if (t !== null) window.clearTimeout(t);
		}
		entry.idleTimer = null;
		entry.restartTimer = null;
		entry.stableTimer = null;
	}

	private drop(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		this.clearTimers(entry);
		try {
			entry.client?.disconnect();
		} catch {
			/* transport may already be dead */
		}
		entry.transport?.dispose();
	}

	private setStatus(
		entry: Entry,
		status: ServerStatus,
		detail: string | null,
	): void {
		this.emit({
			key: entry.key,
			realRoot: entry.realRoot,
			languageId: entry.languageId,
			status,
			detail,
		});
	}

	private emit(state: ServerState): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(state);
			} catch (err) {
				console.error("Onyx: LSP status listener threw:", err);
			}
		}
	}
}
