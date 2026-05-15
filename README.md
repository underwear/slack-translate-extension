# Slack Local AI

A Chrome extension that adds **on-device AI** to the Slack web app:

- **Translate** foreign-language messages into your native language with a click — appears as a "Translate" link under every message.
- **✨ Rewrite in English** button next to Send — turns a draft in any language (or rough English) into clear, well-formatted English ready to post.

Everything runs **locally via Chrome's built-in AI APIs** (Translator, Language Detector, Gemini Nano Prompt API). No API keys. No network calls. No data leaves your browser.

A fork of [limhenry/slack-translate-extension](https://github.com/limhenry/slack-translate-extension) — original UI/DOM approach kept, Google Translate replaced with on-device models.

## Requirements

- **Chrome 138+** on desktop (Windows 10/11, macOS 13+, Linux, ChromeOS).
- ~22 GB free disk space (Gemini Nano weights are ~2 GB).
- Some Chrome AI APIs may need flags enabled. Open `chrome://flags` and turn on:
  - `#prompt-api-for-gemini-nano` — Enabled
  - `#optimization-guide-on-device-model` — Enabled BypassPerfRequirement
  - `#translation-api`, `#language-detection-api` — Enabled
- Then visit `chrome://components/`, find **Optimization Guide On Device Model**, click "Check for update" so Gemini Nano downloads.

## Install (unpacked)

```sh
git clone https://github.com/underwear/slack-translate-extension.git
cd slack-translate-extension
git checkout local-ai
```

1. Open `chrome://extensions/`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select the `src/` folder.
4. Click the extension icon → opens settings. Pick your native language, click **Download models** to pre-fetch on-device models.
5. Open Slack (`app.slack.com`) and look for the Translate links under messages and the ✨ icon next to the Send button.

## How it works

```
┌──────────────────────────────┐   postMessage   ┌──────────────────────────┐
│  content.js (isolated world) │ ◀────────────▶ │  ai-runner.js (MAIN world) │
│  UI injection, chrome.storage│                 │  Translator / LangDetector │
└──────────────────────────────┘                 │  LanguageModel (Gemini Nano)│
                                                  └──────────────────────────┘
```

- `content.js` (isolated world) injects buttons into Slack's DOM and reads settings from `chrome.storage`.
- `ai-runner.js` (MAIN world) is where the Chrome AI APIs live. This is critical: `Translator.create()` / `LanguageModel.create()` require **user activation** when a model needs downloading, and that activation only survives if the API call happens directly in the page context (not through `chrome.runtime.sendMessage` to a service worker or offscreen document).
- `options.html` also calls the AI APIs directly so the **Download models** button works on first launch.

For incoming messages: Language Detector picks the source language → Translator translates to your native language.

For outgoing rewrites: Gemini Nano gets a system prompt with formatting rules and two few-shot examples (one with a numbered list, one with prose), `temperature: 0.3`, `topK: 3`. Falls back to Translator if Gemini Nano isn't installed.

## Settings

The rewrite system prompt is editable from the options page. Defaults shape output to:

- Translate non-English to English; polish if already English.
- Use numbered lists for steps, bulleted lists for parallel items, prose otherwise.
- Preserve `@mentions`, `#channels`, URLs, and inline code character-for-character.
- One blank line between paragraphs, never more.
- No greetings, no sign-offs, no meta-commentary — just the rewritten message.

## Troubleshooting

The options page has a **Models** section that shows live status (Ready / Downloading / Not downloaded / Not supported) for each API. If models say "Not downloaded", click **Download models** — that click is the user activation Chrome needs to trigger the download.

If Gemini Nano says "service is not running", you haven't flipped the `#optimization-guide-on-device-model` flag yet (see Requirements above).

If everything reports "Not supported on this device", you're probably running in a fresh/temp Chrome profile (e.g. Playwright). Run in your normal Chrome.

## License

MIT — see [LICENSE](./LICENSE). Original project © Henry Lim.
