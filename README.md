# Onyx

Onyx is an [Obsidian](https://obsidian.md) plugin for editing source files with
CodeMirror 6 and language-server support without leaving Obsidian.

## Features

- Edit common programming and data-file formats inside Obsidian.
- Syntax highlighting, code completion, diagnostics, hover information, and
  go-to-definition through supported language servers.
- Multiple synchronized editor panes, file navigation, Git gutter indicators,
  and configurable autosave behavior.

Onyx is desktop-only. Language-server features require the corresponding
language server to be installed on your system.

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
