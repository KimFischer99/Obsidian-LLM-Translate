# LLM Translator

A local LLM-powered translation plugin for Obsidian, supporting real-time text selection translation in PDF and Markdown files.

## Positioning

LLM Translator is designed as a **local-first, privacy-friendly** translation tool. By connecting to locally deployed large language models (like Ollama), it enables high-quality translation without internet connection or data leakage. It also supports cloud APIs and free translation services for different use cases.

## Features

- **Multiple Translation Sources**
  - Local LLM (Ollama)
  - Cloud API (OpenAI-compatible format)
  - Google Translate (free)
  - Bing Translate (free)

- **Multi-format Document Support**
  - PDF text selection translation (default)
  - Markdown editor text selection translation (enable "Global" mode in settings)

- **Smart Interaction**
  - Auto-popup translation window on text selection
  - Sidebar translation panel for manual input
  - Copy translation, retry, language switching
  - Custom translation prompt

- **Multi-language Interface**
  - Automatically follows Obsidian system language
  - Supports Chinese and English interface

## Recommended Setup: Using Ollama Local Model

### Why Local Models?

- **Privacy**: Text never leaves your machine, ideal for sensitive documents
- **Offline**: No internet connection required
- **Unlimited**: No call limits, completely free

### Step 1: Install Ollama

Visit [Ollama website](https://ollama.com/) to download and install the version for your system.

**macOS / Linux:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Windows:**
Download the installer from the official website and follow the prompts. Ollama will automatically run in the background after installation.

### Step 2: Pull Translation Model

We recommend Tencent's open-source HY-MT2-1.8B translation model, which is small in size and high in quality:

```bash
ollama pull RogerBen/HY-MT2-1.8B:latest
```

> 💡 This model is about 1.5GB. The first download may take some time. Once downloaded, it can be used offline.

### Step 3: Configure Plugin

1. Open Obsidian, go to **Settings → Community plugins**
2. Enable **LLM Translator**
3. Click the plugin settings icon to open the settings page
4. Fill in the following recommended settings:

| Setting | Recommended Value |
|---------|-------------------|
| Translation scope | Global |
| Translation service | Local LLM |
| Local model endpoint | `http://localhost:11434` |
| Model name | `RogerBen/HY-MT2-1.8B:latest` |
| Source language | Auto |
| Target language | 简体中文 |

5. Click **Test** button to verify connection

### Step 4: Test Translation

1. Open any PDF or Markdown file
2. Select some text
3. The translation popup should appear automatically with the translation result

## Other Translation Service Configuration

### Cloud API (OpenAI-Compatible Format)

Supports any API service provider compatible with OpenAI format.

Configuration steps:
1. Select **Cloud API** service in plugin settings
2. Enter the corresponding API URL and API Key
3. Enter the model name
4. Click **Test** to verify connection

### Google Translate / Bing Translate

No configuration needed. Simply select from the translation service dropdown menu.

> ⚠️ Free translation services may have rate limits. For heavy usage, consider switching to local models or cloud APIs.

## Usage Guide

### Basic Operations

- **Auto-translate**: Translation popup appears automatically after text selection (can be disabled in settings)
- **Sidebar**: Click the language icon in the left toolbar to open the translation panel
- **Manual translation**: Enter text in the sidebar and click the Translate button

### Translation Scope Setting

In **Settings → General → Translation scope**, choose:

- **Global**: Both PDF and Markdown files support text selection translation
- **PDF only**: Only enable text selection translation in PDF files (default)

### Sidebar Features

- **Translation service switch**: Quickly switch between different translation services
- **Language selection**: Set source and target languages
- **Auto-Trans**: Toggle auto-translation feature
- **Copy buttons**: Copy source text, translation, or both
- **Clear**: Clear current translation history

### Custom Prompt

In **Settings → Advanced → Custom prompt**, you can modify the translation prompt to get translation results that better suit your needs.

For example, if you mainly translate academic papers, you can add:
```
Translate the following academic text. Preserve technical terminology, citations, and formulas. Output only the translation.
```

### Advanced Parameters (Ollama Local Model)

- **Top K**: Limit the number of candidate tokens (default 20)
- **Top P**: Control the nucleus sampling range (default 0.6)
- **Repeat Penalty**: Reduce the probability of repeated output (default 1.05)
- **Num Predict**: Maximum number of tokens to generate per request (default 4096)

> 💡 These parameters usually stay at default values. If you need to adjust them, refer to the Ollama official documentation.

## Windows System Notes

This plugin is primarily developed and tested on macOS. Windows users should pay attention to the following:

### Ollama Installation

- Windows version of Ollama will automatically run in the background after installation
- Default port is the same as macOS: `http://localhost:11434`
- If you encounter connection issues, check if Windows Firewall is blocking local connections

### Path Issues

- Windows paths use backslashes `\`, but URLs in plugin configuration should use forward slashes `/`
- Example: `http://localhost:11434` (correct), do not write as `http://localhost:11434\`

### Common Issues

1. **Test connection failed**
   - Confirm Ollama is running (there should be an Ollama icon in the taskbar)
   - Try accessing `http://localhost:11434` in your browser to confirm the service is normal
   - Check if another program is using port 11434

2. **Translation popup not showing**
   - Confirm "Auto-translate selected text" is enabled in settings
   - Confirm "Enable reader selection popup" is enabled in settings
   - Try restarting Obsidian

3. **Markdown files cannot be translated**
   - Confirm "Translation scope" is set to "Global" in settings

## Development

```bash
# Install dependencies
npm install

# Development mode (watch for file changes)
npm run dev

# Production build
npm run build
```

After building, copy `main.js`, `manifest.json`, and `styles.css` to:

```
YourVault/.obsidian/plugins/llm-translator/
```

## License

MIT License
