// Onyx runs in Electron's renderer, so plugin code freely uses `window.*`
// (setTimeout/clearTimeout). Under vitest's node environment there's no
// `window`; alias it to globalThis so timers (and vi.useFakeTimers) work.
import { vi } from "vitest";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
	vi.stubGlobal("window", globalThis);
}
