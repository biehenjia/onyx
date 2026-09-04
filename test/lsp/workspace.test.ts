import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import type { LSPClient } from "@codemirror/lsp-client";
import { ObsidianWorkspace } from "../../src/lsp/workspace";
import { mirroredEdit } from "../../src/main";
import type OnyxPlugin from "../../src/main";

function fakeView(doc = ""): EditorView {
	return {
		state: { doc },
		dispatch: vi.fn(),
	} as unknown as EditorView;
}

function fakeClient() {
	return {
		didOpen: vi.fn(),
		didClose: vi.fn(),
		sync: vi.fn(),
	} as unknown as LSPClient & {
		didOpen: ReturnType<typeof vi.fn>;
		didClose: ReturnType<typeof vi.fn>;
		sync: ReturnType<typeof vi.fn>;
	};
}

const URI = "file:///proj/src/a.ts";

function makeWorkspace() {
	const client = fakeClient();
	const ws = new ObsidianWorkspace(client, {} as unknown as OnyxPlugin);
	return { ws, client };
}

describe("ObsidianWorkspace — multi-view file tracking", () => {
	it("didOpen fires once no matter how many panes open the file", () => {
		const { ws, client } = makeWorkspace();
		const v1 = fakeView();
		const v2 = fakeView();

		ws.openFile(URI, "typescript", v1);
		ws.openFile(URI, "typescript", v2);

		expect(client.didOpen).toHaveBeenCalledTimes(1);
		expect(ws.files).toHaveLength(1);
		expect(ws.getFile(URI)?.getView()).toBe(v1);
	});

	it("getView honours the main hint, falls back to the oldest pane", () => {
		const { ws } = makeWorkspace();
		const v1 = fakeView();
		const v2 = fakeView();
		ws.openFile(URI, "typescript", v1);
		ws.openFile(URI, "typescript", v2);

		const file = ws.getFile(URI)!;
		expect(file.getView()).toBe(v1);
		expect(file.getView(v2)).toBe(v2);
		expect(file.getView(fakeView())).toBe(v1); // unknown hint ignored
	});

	it("didClose only fires when the last pane closes", () => {
		const { ws, client } = makeWorkspace();
		const v1 = fakeView();
		const v2 = fakeView();
		ws.openFile(URI, "typescript", v1);
		ws.openFile(URI, "typescript", v2);

		ws.closeFile(URI, v1);
		expect(client.didClose).not.toHaveBeenCalled();
		expect(ws.files).toHaveLength(1);
		expect(ws.getFile(URI)?.getView()).toBe(v2); // re-elected

		ws.closeFile(URI, v2);
		expect(client.didClose).toHaveBeenCalledTimes(1);
		expect(ws.files).toHaveLength(0);
	});

	it("flushes pending edits when the elected source pane leaves peers behind", () => {
		const { ws, client } = makeWorkspace();
		const v1 = fakeView();
		const v2 = fakeView();
		ws.openFile(URI, "typescript", v1);
		ws.openFile(URI, "typescript", v2);

		ws.closeFile(URI, v1); // v1 was the elected source, v2 remains
		expect(client.sync).toHaveBeenCalledTimes(1);

		client.sync.mockClear();
		ws.closeFile(URI, v2); // last pane — nothing to hand over
		expect(client.sync).not.toHaveBeenCalled();
	});

	it("closing an unknown pane / a closed file is a no-op", () => {
		const { ws, client } = makeWorkspace();
		const v1 = fakeView();
		ws.openFile(URI, "typescript", v1);

		ws.closeFile(URI, fakeView()); // pane never opened this file
		expect(client.didClose).not.toHaveBeenCalled();
		expect(ws.files).toHaveLength(1);

		ws.closeFile(URI, v1);
		ws.closeFile(URI, v1); // double close
		expect(client.didClose).toHaveBeenCalledTimes(1);
	});

	it("updateFile fans a server edit out to every pane, marked as mirrored", () => {
		const { ws } = makeWorkspace();
		const v1 = fakeView();
		const v2 = fakeView();
		ws.openFile(URI, "typescript", v1);
		ws.openFile(URI, "typescript", v2);

		ws.updateFile(URI, { changes: { from: 0, to: 0, insert: "x" } });

		for (const v of [v1, v2]) {
			const dispatch = v.dispatch as unknown as ReturnType<typeof vi.fn>;
			expect(dispatch).toHaveBeenCalledTimes(1);
			const spec = dispatch.mock.calls[0][0];
			expect(spec.annotations.type).toBe(mirroredEdit);
			expect(spec.annotations.value).toBe(true);
		}
	});

	it("updateFile ignores a uri with no open file", () => {
		const { ws } = makeWorkspace();
		expect(() =>
			ws.updateFile("file:///nope.ts", { changes: [] }),
		).not.toThrow();
	});
});
