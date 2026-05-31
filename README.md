# LLM Translate

LLM Translate is an Obsidian desktop plugin that translates selected text in Obsidian's native PDF reader with a local Ollama model.

## Features

- Translate PDF selections into Simplified Chinese.
- Use Ollama's native `/api/chat` endpoint.
- Show results in a floating popup near the PDF selection.
- Provide grouped settings inspired by Zotero PDF Translate.

## Development

```bash
npm install
npm run dev
```

Build a production bundle:

```bash
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
YourVault/.obsidian/plugins/llm-translate/
```
