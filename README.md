# Onyx

Onyx is an [Obsidian](https://obsidian.md) plugin for editing source files with
CodeMirror 6 and language-server support without leaving Obsidian.

## Features

- Edit common programming and data-file formats inside Obsidian.
- Syntax highlighting, code completion, diagnostics, hover information, and
  go-to-definition through supported language servers.
- Multiple synchronized editor panes, file navigation, Git gutter indicators,
  and configurable autosave behavior.
- A source-ordered, nested code outline in the right sidebar, with the current
  namespace/class/function chain shown in the editor's navigation breadcrumb.

Onyx is desktop-only. Language servers are configured explicitly by each
project. Put `onyx.toml` at the project root, for example:

```toml
name = "My C++ project"

[lsp.cpp]
command = ["nix", "develop", ".", "-c", "clangd"]
```

The file's directory is the project root. Commands are exact argument arrays:
Onyx does not invoke a shell, guess project boundaries, choose server versions,
or modify `PATH`. Before running a new or changed configuration, use **Onyx:
Trust current project's language server** and review the displayed command.

## Installation

Install Onyx through Obsidian's community plugins browser when it becomes
available. For a manual installation, download `main.js`, `manifest.json`, and
`styles.css` from a release and place them in:

```text
<vault>/.obsidian/plugins/onyx/
```

Restart Obsidian, then enable **Onyx** under **Settings → Community plugins**.

## Development

```sh
npm install
npm test
npm run lint
npm run build
```

## License

[MIT](LICENSE)
