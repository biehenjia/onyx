import type { Highlighter } from "@lezer/highlight";
import { highlightCode } from "@lezer/highlight";
import { languageByName } from "../languages";

/** LSP language id (`textDocument.languageId`) -> a tag `languageByName` knows. */
export function lspIdToLanguageTag(id: string): string {
	if (id === "typescriptreact") return "tsx";
	if (id === "javascriptreact") return "jsx";
	return id;
}

/** Source text of an element, treating `<br>` (lsp-client's newline) as `\n`. */
function reconstructSource(el: Element): string {
	let out = "";
	for (const node of Array.from(el.childNodes)) {
		out += node.nodeName === "BR" ? "\n" : (node.textContent ?? "");
	}
	return out;
}

function rehighlight(
	codeEl: Element,
	tag: string,
	highlighter: Highlighter,
): void {
	const lang = languageByName(tag);
	if (!lang) return;
	const src = reconstructSource(codeEl);
	if (!src.trim()) return;

	const out: Node[] = [];
	highlightCode(
		src,
		lang.parser.parse(src),
		highlighter,
		(text, cls) => {
			out.push(
				cls
					? createSpan({ cls, text })
					: codeEl.ownerDocument.createTextNode(text),
			);
		},
		() => out.push(createEl("br")),
	);
	if (out.length) codeEl.replaceChildren(...out);
}

/**
 * Highlight code inside an already-rendered LSP doc (hover / completion /
 * signature help), in place.
 *
 * lsp-client highlights *fenced* blocks itself (when a `highlightLanguage` is
 * configured); this fills the gap for **inline `code`** — clangd's "Parameters:"
 * list, `std::x` mentions in prose — which markdown never associates a language
 * with. Inline code is highlighted as `fileLanguageId` (the hovered file's
 * language). The same `highlighter` the editor uses is passed through, so the
 * classes and colours match the fenced blocks and the editor.
 */
export function highlightDocCodeInto(
	root: HTMLElement,
	fileLanguageId: string,
	highlighter: Highlighter,
): void {
	const fileTag = lspIdToLanguageTag(fileLanguageId);

	for (const codeEl of Array.from(root.querySelectorAll("code"))) {
		const inPre = codeEl.parentElement?.tagName === "PRE";
		// lsp-client already tokenised this fenced block.
		if (inPre && codeEl.querySelector("span")) continue;

		let tag = fileTag;
		if (inPre) {
			const m = /language-([\w+#.-]+)/.exec(codeEl.className);
			if (m) tag = m[1];
		}
		rehighlight(codeEl, tag, highlighter);
	}
}
