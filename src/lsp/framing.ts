/**
 * `Content-Length`-framed message reassembly for LSP-over-stdio, split out from
 * {@link StdioTransport} so the parsing — and its safety caps — can be tested
 * without spawning a child process.
 *
 * A misbehaving server (a stray `print`, a stack trace, a crash dump on stdout,
 * or a bogus `Content-Length`) must not be able to make us buffer without bound
 * or wait forever. On any such breach the framer discards what it has, counts
 * the incident, and — after {@link MAX_RESETS} incidents — reports the stream as
 * unrecoverable so the transport can be torn down.
 */

/** Hard ceiling on unframed bytes held while waiting for a header. */
export const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Largest `Content-Length` we'll agree to accumulate for a single message. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Framing breaches tolerated before the stream is declared unrecoverable. */
export const MAX_RESETS = 5;

export interface FramerHooks {
	/** A complete, well-framed message body (already decoded as UTF-8). */
	onMessage(body: string): void;
	/** The stream is unrecoverable ({@link MAX_RESETS} breaches). */
	onFatal(reason: string): void;
}

export class LspFramer {
	private buf = Buffer.alloc(0);
	/** Byte length of the body we're currently waiting for; -1 = expecting a header. */
	private expected = -1;
	private resets = 0;

	constructor(private readonly hooks: FramerHooks) {}

	ingest(chunk: Buffer): void {
		this.buf = Buffer.concat([this.buf, chunk]);

		for (;;) {
			if (this.expected < 0) {
				const headerEnd = this.buf.indexOf("\r\n\r\n");
				if (headerEnd < 0) {
					// No header yet. If unframed bytes have blown past the cap
					// there is no plausible header coming — the stream is junk.
					if (this.buf.length > MAX_BUFFER_BYTES) {
						this.reset(
							`no message header in the first ${this.buf.length} bytes`,
						);
					}
					return;
				}
				const header = this.buf
					.subarray(0, headerEnd)
					.toString("ascii");
				const match = /content-length:\s*(\d+)/i.exec(header);
				this.buf = this.buf.subarray(headerEnd + 4);
				if (!match) continue; // desynced header block; skip it

				const len = Number.parseInt(match[1], 10);
				if (!Number.isFinite(len) || len < 0 || len > MAX_MESSAGE_BYTES) {
					this.reset(`Content-Length ${match[1]} out of range`);
					return;
				}
				this.expected = len;
			}

			if (this.buf.length < this.expected) return; // body still arriving

			const body = this.buf.subarray(0, this.expected).toString("utf8");
			this.buf = this.buf.subarray(this.expected);
			this.expected = -1;
			this.hooks.onMessage(body);
		}
	}

	private reset(reason: string): void {
		const sample = JSON.stringify(
			this.buf.subarray(0, 200).toString("utf8"),
		);
		console.error(
			`Onyx: LSP framing error (${reason}); discarding ${this.buf.length} buffered bytes. First bytes: ${sample}`,
		);
		this.buf = Buffer.alloc(0);
		this.expected = -1;
		this.resets++;
		if (this.resets >= MAX_RESETS) {
			this.hooks.onFatal(
				`language server produced unframeable output ${this.resets} times`,
			);
		}
	}
}
