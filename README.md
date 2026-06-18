# EveryAPI for Obsidian

Chat with **240+ LLMs** — Claude, GPT, Gemini, DeepSeek and more — in an Obsidian side panel, all through a single [EveryAPI](https://everyapi.ai) gateway key. The assistant works as an in-vault agent: it reads, searches, and edits your notes with tools (edits always ask for your approval first), and can insert replies straight into the note.

## Features

- **One key, every model.** A single EveryAPI key reaches 240+ models behind one OpenAI-compatible gateway. Switch models per chat from the model chip in the panel.
- **In-vault agent.** The assistant reads, searches, and edits notes across your vault using tools — it fetches exactly the notes it needs instead of guessing. Creating or editing a note always asks for your approval first, and stays confined to the vault.
- **Insert replies into your note.** Drop a reply at the cursor, append it as a blockquote, or copy it to the clipboard.
- **Streaming responses.** Replies stream token-by-token; finished replies render as full markdown.
- **Editor commands.** Run "Explain selection or note", "Improve writing", "Summarize note", and "Continue writing" straight from the command palette.
- **Balance readout.** A status-bar item shows your remaining gateway balance.
- **Desktop and mobile.** Works in both; the streaming path falls back gracefully where the platform doesn't expose a streaming response body.

Your API key is stored in this vault's plugin data (plain JSON). Be careful syncing the vault somewhere untrusted with a live key.

## Getting started

1. Create an API key in the [EveryAPI](https://everyapi.ai) console under **Access Tokens**.
2. Open the EveryAPI panel from the ribbon icon or the "Open chat panel" command.
3. Paste your key into the onboarding card (or under **Settings → EveryAPI → API key**) and connect.
4. Pick a default model (optional) and start chatting.

## Installation

### Community store (once approved)

Search for **EveryAPI** in **Settings → Community plugins → Browse**, install, and enable.

### BRAT

Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, then add this repository (`everyapi-ai/everyapi-obsidian`) as a beta plugin.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from a release (or build them, see below).
2. Copy them into `<vault>/.obsidian/plugins/everyapi/`.
3. Reload Obsidian and enable **EveryAPI** under **Settings → Community plugins**.

## Building from source

```bash
npm install
npm run build   # type-checks, then bundles into dist/ (main.js + manifest.json + styles.css)
npm run dev     # watch mode
```

The bundle is produced by [esbuild](https://esbuild.github.io/); `obsidian`, `electron`, and the CodeMirror packages stay external because the Obsidian runtime provides them.

## Built from

This plugin bundles a small, dependency-free EveryAPI gateway client (vendored under `src/gateway/`) — the same client used by EveryAPI's other editor integrations. It speaks the OpenAI-compatible `/v1` surface (`/v1/models`, `/v1/chat/completions`) plus the account `/api/usage/token/` endpoint for the balance readout.

## License

[MIT](./LICENSE)
