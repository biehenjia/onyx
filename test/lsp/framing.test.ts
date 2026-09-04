import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LspFramer,
	MAX_BUFFER_BYTES,
	MAX_MESSAGE_BYTES,
	MAX_RESETS,
} from "../../src/lsp/framing";

function frame(body: string): Buffer {
	const b = Buffer.from(body, "utf8");
	return Buffer.concat([
		Buffer.from(`Content-Length: ${b.length}\r\n\r\n`, "ascii"),
		b,
	]);
}

function makeFramer() {
	const messages: string[] = [];
	const fatals: string[] = [];
	const framer = new LspFramer({
		onMessage: (m) => messages.push(m),
		onFatal: (r) => fatals.push(r),
	});
	return { framer, messages, fatals };
}

describe("LspFramer", () => {
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errSpy.mockRestore();
	});

	it("delivers a single well-framed message", () => {
		const { framer, messages } = makeFramer();
		framer.ingest(frame('{"jsonrpc":"2.0"}'));
		expect(messages).toEqual(['{"jsonrpc":"2.0"}']);
	});

	it("reassembles a message split across chunks", () => {
		const { framer, messages } = makeFramer();
		const buf = frame('{"a":1,"b":2}');
		framer.ingest(buf.subarray(0, 4));
		framer.ingest(buf.subarray(4, 20));
		framer.ingest(buf.subarray(20));
		expect(messages).toEqual(['{"a":1,"b":2}']);
	});

	it("delivers multiple messages from one chunk", () => {
		const { framer, messages } = makeFramer();
		framer.ingest(Buffer.concat([frame('"one"'), frame('"two"'), frame('"three"')]));
		expect(messages).toEqual(['"one"', '"two"', '"three"']);
	});

	it("keeps multibyte UTF-8 intact across a chunk boundary", () => {
		const { framer, messages } = makeFramer();
		const body = '{"s":"café — 日本語 😀"}';
		const buf = frame(body);
		// split in the middle of a multibyte sequence
		const mid = buf.length - 5;
		framer.ingest(buf.subarray(0, mid));
		framer.ingest(buf.subarray(mid));
		expect(messages).toEqual([body]);
	});

	it("skips a header block with no Content-Length, then recovers", () => {
		const { framer, messages } = makeFramer();
		framer.ingest(Buffer.from("X-Weird: 1\r\n\r\n", "ascii"));
		framer.ingest(frame('"ok"'));
		expect(messages).toEqual(['"ok"']);
	});

	it("resets instead of buffering unbounded garbage on stdout", () => {
		const { framer, messages, fatals } = makeFramer();
		framer.ingest(Buffer.alloc(MAX_BUFFER_BYTES + 1024, 0x78)); // 'x', no header
		expect(messages).toEqual([]);
		expect(fatals).toEqual([]);
		expect(errSpy).toHaveBeenCalledOnce();
		// stream recovers for a subsequent valid frame
		framer.ingest(frame('"after"'));
		expect(messages).toEqual(['"after"']);
	});

	it("rejects an out-of-range Content-Length without waiting for bytes", () => {
		const { framer, messages } = makeFramer();
		framer.ingest(
			Buffer.from(
				`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`,
				"ascii",
			),
		);
		expect(messages).toEqual([]);
		expect(errSpy).toHaveBeenCalledOnce();
		framer.ingest(frame('"after"'));
		expect(messages).toEqual(['"after"']);
	});

	it("declares the stream fatal after repeated breaches", () => {
		const { framer, fatals } = makeFramer();
		for (let i = 0; i < MAX_RESETS; i++) {
			expect(fatals).toEqual([]);
			framer.ingest(
				Buffer.from("Content-Length: 99999999999\r\n\r\n", "ascii"),
			);
		}
		expect(fatals).toHaveLength(1);
		expect(fatals[0]).toMatch(/unframeable/);
	});
});
