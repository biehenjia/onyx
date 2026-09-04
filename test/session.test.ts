import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeSet } from "@codemirror/state";
import type { ConflictChoice } from "../src/conflict";
import {
	DocumentSession,
	type ConflictPrompt,
	type LspBinding,
} from "../src/session";
import type { CodeView } from "../src/main";
import type { SavePolicy } from "../src/settings";

function fakeView(text = "") {
	const v = {
		_text: text,
		getEditorText: () => v._text,
		setEditorText: vi.fn((t: string) => {
			v._text = t;
		}),
		applyMirroredChanges: vi.fn(),
		applyMirroredDiagnostics: vi.fn(),
		setLspExtension: vi.fn(),
		refreshDirtyIndicator: vi.fn(),
		save: vi.fn(async () => {
			// a real save persists the buffer and marks the session clean
			v._saved?.();
		}),
		_saved: undefined as (() => void) | undefined,
	};
	return v;
}
type FakeView = ReturnType<typeof fakeView>;
const asView = (v: FakeView) => v as unknown as CodeView;

function fakeBinding() {
	const client = {
		plugin: vi.fn(() => "EXT"),
		sync: vi.fn(),
		notification: vi.fn(),
	};
	const binding: LspBinding = {
		fileUri: "file:///proj/a.ts",
		languageId: "typescript",
		realRoot: "/proj",
		acquire: vi.fn(() => client as never),
		current: vi.fn(() => client as never),
		release: vi.fn(),
	};
	return { binding, client };
}

function makeSession(
	initial = "",
	opts: {
		policy?: SavePolicy;
		binding?: LspBinding;
		delayMs?: number;
		prompt?: ConflictPrompt;
	} = {},
) {
	const onDirtyChange = vi.fn();
	const session = new DocumentSession(
		"proj/a.ts",
		initial,
		() => opts.policy ?? "manual",
		onDirtyChange,
		opts.binding ?? null,
		() => opts.delayMs ?? 2000,
		opts.prompt,
	);
	return { session, onDirtyChange };
}

describe("DocumentSession — multi-view LSP binding", () => {
	it("binds the language server to every attached view (C2)", () => {
		const { binding, client } = fakeBinding();
		const { session } = makeSession("", { binding });
		const v1 = fakeView();
		const v2 = fakeView();

		session.attach(asView(v1));
		session.attach(asView(v2));

		expect(binding.acquire).toHaveBeenCalledTimes(1); // client cached
		expect(v1.setLspExtension).toHaveBeenCalledWith("EXT");
		expect(v2.setLspExtension).toHaveBeenCalledWith("EXT");
		expect(client.plugin).toHaveBeenCalledTimes(2);
	});

	it("releases the server only when the last view detaches, and flushes first", () => {
		const { binding, client } = fakeBinding();
		const { session } = makeSession("", { binding });
		const v1 = fakeView();
		const v2 = fakeView();
		session.attach(asView(v1));
		session.attach(asView(v2));

		session.detach(asView(v1));
		expect(client.sync).toHaveBeenCalledTimes(1); // flush on every detach
		expect(binding.release).not.toHaveBeenCalled();

		session.detach(asView(v2));
		expect(binding.release).toHaveBeenCalledTimes(1);
	});

	it("detach is idempotent (C3): double calls never double-release", () => {
		const { binding } = fakeBinding();
		const { session } = makeSession("", { binding });
		const v1 = fakeView();
		const v2 = fakeView();
		session.attach(asView(v1));
		session.attach(asView(v2));

		session.detach(asView(v1));
		session.detach(asView(v1)); // already gone
		expect(session.size).toBe(1);
		expect(binding.release).not.toHaveBeenCalled();

		session.detach(asView(v2));
		session.detach(asView(v2)); // already empty
		expect(session.size).toBe(0);
		expect(binding.release).toHaveBeenCalledTimes(1);
	});

	it("resyncLsp re-binds a fresh client to every view, and no-ops when unchanged", () => {
		const { binding, client } = fakeBinding();
		const { session } = makeSession("", { binding });
		const v1 = fakeView();
		const v2 = fakeView();
		session.attach(asView(v1));
		session.attach(asView(v2));
		v1.setLspExtension.mockClear();
		v2.setLspExtension.mockClear();

		session.resyncLsp(); // current() returns the same client -> no churn
		expect(v1.setLspExtension).not.toHaveBeenCalled();

		const fresh = { plugin: vi.fn(() => "EXT2"), sync: vi.fn() };
		(binding.current as ReturnType<typeof vi.fn>).mockReturnValue(fresh);
		session.resyncLsp();
		expect(v1.setLspExtension).toHaveBeenCalledWith("EXT2");
		expect(v2.setLspExtension).toHaveBeenCalledWith("EXT2");
	});
});

describe("DocumentSession — mirroring & dirty state", () => {
	it("mirrors a local edit to peers but not the origin", () => {
		const { session } = makeSession("a");
		const v1 = fakeView("a");
		const v2 = fakeView("a");
		const v3 = fakeView("a");
		session.attach(asView(v1));
		session.attach(asView(v2));
		session.attach(asView(v3));

		const cs = ChangeSet.empty(1);
		session.handleLocalChange(asView(v1), cs);

		expect(v1.applyMirroredChanges).not.toHaveBeenCalled();
		expect(v2.applyMirroredChanges).toHaveBeenCalledWith(cs);
		expect(v3.applyMirroredChanges).toHaveBeenCalledWith(cs);
	});

	it("mirrors diagnostics to peers but not the origin", () => {
		const { session } = makeSession("a");
		const v1 = fakeView("a");
		const v2 = fakeView("a");
		session.attach(asView(v1));
		session.attach(asView(v2));

		session.mirrorDiagnostics(asView(v1), []);
		expect(v1.applyMirroredDiagnostics).not.toHaveBeenCalled();
		expect(v2.applyMirroredDiagnostics).toHaveBeenCalledWith([]);
	});

	it("recomputes dirty from any view and notifies every peer once", () => {
		const { session, onDirtyChange } = makeSession("a");
		const v1 = fakeView("a");
		const v2 = fakeView("a");
		session.attach(asView(v1));
		session.attach(asView(v2));

		v1._text = "ab"; // an edit landed
		session.handleLocalChange(asView(v1), ChangeSet.empty(1));

		expect(session.dirty).toBe(true);
		expect(v1.refreshDirtyIndicator).toHaveBeenCalledTimes(1);
		expect(v2.refreshDirtyIndicator).toHaveBeenCalledTimes(1);
		expect(onDirtyChange).toHaveBeenCalledTimes(1);

		v1._text = "a"; // reverted
		session.markSaved();
		// markSaved sets savedText = currentText -> not dirty
		expect(session.dirty).toBe(false);
	});

});

describe("DocumentSession — save scheduling (C5)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function dirtyEdit(session: DocumentSession, v: FakeView, text: string) {
		v._text = text;
		session.handleLocalChange(asView(v), ChangeSet.empty(1));
	}

	it("afterDelay debounces one save at the configured delay", () => {
		const { session } = makeSession("a", {
			policy: "afterDelay",
			delayMs: 1000,
		});
		const v1 = fakeView("a");
		v1._saved = () => session.markSaved();
		session.attach(asView(v1));

		dirtyEdit(session, v1, "ab");
		vi.advanceTimersByTime(999);
		expect(v1.save).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(v1.save).toHaveBeenCalledTimes(1);
	});

	it("each keystroke resets the debounce — only one save fires", () => {
		const { session } = makeSession("a", {
			policy: "afterDelay",
			delayMs: 1000,
		});
		const v1 = fakeView("a");
		v1._saved = () => session.markSaved();
		session.attach(asView(v1));

		dirtyEdit(session, v1, "ab");
		vi.advanceTimersByTime(600);
		dirtyEdit(session, v1, "abc");
		vi.advanceTimersByTime(600); // 1200ms since first edit, 600 since last
		expect(v1.save).not.toHaveBeenCalled();
		vi.advanceTimersByTime(400);
		expect(v1.save).toHaveBeenCalledTimes(1);
	});

	it("manual policy never schedules a save; saveNow flushes", async () => {
		const { session } = makeSession("a", { policy: "manual" });
		const v1 = fakeView("a");
		v1._saved = () => session.markSaved();
		session.attach(asView(v1));

		dirtyEdit(session, v1, "ab");
		vi.advanceTimersByTime(10_000);
		expect(v1.save).not.toHaveBeenCalled();

		session.saveNow();
		await vi.runAllTimersAsync();
		expect(v1.save).toHaveBeenCalledTimes(1);
	});

	it("onFocusChange flushes on blur, not on a timer", () => {
		const { session } = makeSession("a", { policy: "onFocusChange" });
		const v1 = fakeView("a");
		v1._saved = () => session.markSaved();
		session.attach(asView(v1));

		dirtyEdit(session, v1, "ab");
		vi.advanceTimersByTime(10_000);
		expect(v1.save).not.toHaveBeenCalled();

		session.notifyBlur();
		expect(v1.save).toHaveBeenCalledTimes(1);
	});

	it("a pending autosave is cancelled once the last view detaches", () => {
		const { session } = makeSession("a", {
			policy: "afterDelay",
			delayMs: 1000,
		});
		const v1 = fakeView("a");
		v1._saved = () => session.markSaved();
		session.attach(asView(v1));

		dirtyEdit(session, v1, "ab");
		session.detach(asView(v1));
		vi.advanceTimersByTime(5000);
		expect(v1.save).not.toHaveBeenCalled();
	});
});

describe("DocumentSession — didSave (C5)", () => {
	it("notifies the server on a save that cleared a dirty buffer", () => {
		const { binding, client } = fakeBinding();
		const { session } = makeSession("a", { binding });
		const v1 = fakeView("a");
		session.attach(asView(v1));

		v1._text = "ab";
		session.handleLocalChange(asView(v1), ChangeSet.empty(1));
		expect(session.dirty).toBe(true);

		session.markSaved();
		expect(client.notification).toHaveBeenCalledWith("textDocument/didSave", {
			textDocument: { uri: "file:///proj/a.ts" },
		});
	});

	it("does not notify when nothing was dirty", () => {
		const { binding, client } = fakeBinding();
		const { session } = makeSession("a", { binding });
		session.attach(asView(fakeView("a")));

		session.markSaved();
		expect(client.notification).not.toHaveBeenCalled();
	});
});

describe("DocumentSession — external change / conflict (C4)", () => {
	it("adopts the disk version when the buffer is clean", () => {
		const { session } = makeSession("a");
		const v1 = fakeView("a");
		const v2 = fakeView("a");
		session.attach(asView(v1));
		session.attach(asView(v2));

		session.handleExternalChange("from-disk");
		expect(v1.setEditorText).toHaveBeenCalledWith("from-disk", false);
		expect(v2.setEditorText).toHaveBeenCalledWith("from-disk", false);
		expect(session.dirty).toBe(false);
	});

	it("no prompt when the disk version already matches the dirty buffer", () => {
		const prompt = vi.fn<ConflictPrompt>();
		const { session } = makeSession("a", { prompt });
		const v1 = fakeView("a");
		session.attach(asView(v1));

		v1._text = "mine";
		session.handleLocalChange(asView(v1), ChangeSet.empty(1));
		session.handleExternalChange("mine"); // disk caught up

		expect(prompt).not.toHaveBeenCalled();
		expect(session.dirty).toBe(false);
	});

	it("prompts on a real conflict; 'reload' discards the buffer", () => {
		let resolve!: (c: ConflictChoice) => void;
		const prompt = vi.fn<ConflictPrompt>((_p, r) => {
			resolve = r;
		});
		const { session } = makeSession("a", { prompt });
		const v1 = fakeView("a");
		session.attach(asView(v1));

		v1._text = "mine";
		session.handleLocalChange(asView(v1), ChangeSet.empty(1));
		session.handleExternalChange("from-disk");

		expect(prompt).toHaveBeenCalledTimes(1);
		resolve("reload");
		expect(v1.setEditorText).toHaveBeenCalledWith("from-disk", false);
		expect(session.dirty).toBe(false);
	});

	it("prompts on a real conflict; 'keep' leaves the buffer, still dirty", () => {
		let resolve!: (c: ConflictChoice) => void;
		const prompt = vi.fn<ConflictPrompt>((_p, r) => {
			resolve = r;
		});
		const { session } = makeSession("a", { prompt });
		const v1 = fakeView("a");
		session.attach(asView(v1));

		v1._text = "mine";
		session.handleLocalChange(asView(v1), ChangeSet.empty(1));
		session.handleExternalChange("from-disk");
		resolve("keep");

		expect(v1.setEditorText).not.toHaveBeenCalled();
		expect(session.dirty).toBe(true); // buffer "mine" != disk "from-disk"
	});

	it("suspends autosave while the prompt is open, resumes on 'keep'", () => {
		vi.useFakeTimers();
		try {
			let resolve!: (c: ConflictChoice) => void;
			const prompt = vi.fn<ConflictPrompt>((_p, r) => {
				resolve = r;
			});
			const { session } = makeSession("a", {
				prompt,
				policy: "afterDelay",
				delayMs: 1000,
			});
			const v1 = fakeView("a");
			v1._saved = () => session.markSaved();
			session.attach(asView(v1));

			v1._text = "mine";
			session.handleLocalChange(asView(v1), ChangeSet.empty(1));
			session.handleExternalChange("from-disk"); // opens prompt

			vi.advanceTimersByTime(5000);
			expect(v1.save).not.toHaveBeenCalled(); // autosave suspended

			resolve("keep");
			vi.advanceTimersByTime(1000);
			expect(v1.save).toHaveBeenCalledTimes(1); // re-armed and fired
		} finally {
			vi.useRealTimers();
		}
	});

	it("holds a second disk change until the open prompt resolves", () => {
		const resolvers: ((c: ConflictChoice) => void)[] = [];
		const prompt = vi.fn<ConflictPrompt>((_p, r) => resolvers.push(r));
		const { session } = makeSession("a", { prompt });
		const v1 = fakeView("a");
		session.attach(asView(v1));

		v1._text = "mine";
		session.handleLocalChange(asView(v1), ChangeSet.empty(1));

		session.handleExternalChange("disk-1");
		session.handleExternalChange("disk-2"); // held, no second prompt yet
		expect(prompt).toHaveBeenCalledTimes(1);

		resolvers[0]("keep"); // savedText = "disk-1", still dirty -> re-evaluate "disk-2"
		expect(prompt).toHaveBeenCalledTimes(2);
		resolvers[1]("reload");
		expect(v1.setEditorText).toHaveBeenCalledWith("disk-2", false);
		expect(session.dirty).toBe(false);
	});
});
