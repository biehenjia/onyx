import { type ChildProcess, spawn } from "child_process";
import type { Transport } from "@codemirror/lsp-client";
import type { SpawnSpec } from "./servers";
import { LspFramer } from "./framing";

/** Why a transport closed — threaded to the registry so it can react (C1). */
export interface ClosureInfo {
	/** Process exit code, when the child exited on its own. */
	code: number | null;
	/** Human-readable cause when we tore it down (spawn failure, bad framing). */
	reason: string | null;
}

/**
 * A `@codemirror/lsp-client` {@link Transport} backed by a child process
 * speaking LSP over stdio. lsp-client deals in bare JSON strings; this class
 * owns the `Content-Length` framing (via {@link LspFramer}) in both directions.
 */
export class StdioTransport implements Transport {
	private child: ChildProcess | null = null;
	private readonly handlers = new Set<(value: string) => void>();
	private closed = false;

	private readonly framer = new LspFramer({
		onMessage: (body) => this.deliver(body),
		onFatal: (reason) => this.fail(`transport framing: ${reason}`),
	});

	constructor(
		spec: SpawnSpec,
		/** Called exactly once when the child exits or is torn down. */
		private readonly onClosed: (info: ClosureInfo) => void,
	) {
		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: spec.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		child.stdout?.on("data", (d: Buffer) => this.framer.ingest(d));
		child.stderr?.on("data", (d: Buffer) => {
			const text = d.toString("utf8").trimEnd();
			if (text) console.debug("Onyx LSP:", text);
		});
		child.on("error", (err) => {
			console.error("Onyx: language server failed to start:", err);
			this.child = null;
			this.fail(`failed to start: ${err.message}`);
		});
		child.on("exit", (code) => {
			this.child = null;
			this.emitClosed({
				code,
				reason: code ? `server exited with code ${code}` : null,
			});
		});
	}

	send(message: string): void {
		if (!this.child?.stdin) throw new Error("Onyx: LSP transport is closed");
		const body = Buffer.from(message, "utf8");
		const header = Buffer.from(
			`Content-Length: ${body.length}\r\n\r\n`,
			"ascii",
		);
		this.child.stdin.write(Buffer.concat([header, body]));
	}

	subscribe(handler: (value: string) => void): void {
		this.handlers.add(handler);
	}

	unsubscribe(handler: (value: string) => void): void {
		this.handlers.delete(handler);
	}

	dispose(): void {
		// Deliberate teardown: suppress the exit/error callback so the registry
		// doesn't mistake a restart or shutdown for a crash.
		this.closed = true;
		this.handlers.clear();
		const child = this.child;
		this.child = null;
		if (!child) return;
		try {
			child.stdin?.end();
		} catch {
			/* already gone */
		}
		child.kill("SIGTERM");
		window.setTimeout(() => child.kill("SIGKILL"), 2000);
	}

	/** Kill the child and report an abnormal close with a reason. */
	private fail(reason: string): void {
		const child = this.child;
		this.child = null;
		child?.kill("SIGKILL");
		this.emitClosed({ code: null, reason });
	}

	private emitClosed(info: ClosureInfo): void {
		if (this.closed) return;
		this.closed = true;
		this.onClosed(info);
	}

	private deliver(body: string): void {
		for (const handler of [...this.handlers]) {
			try {
				handler(body);
			} catch (err) {
				console.error("Onyx: LSP message handler threw:", err);
			}
		}
	}
}
