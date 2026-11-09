# Gemini Chat Exporter

<div align="center">

![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Compatibility](https://img.shields.io/badge/browsers-Chrome%20%7C%20Zen%20%7C%20Firefox-brightgreen.svg)

**Full-featured backup and export tool for Google Gemini conversations, modeled after `deepseek-exporter`**

</div>

---

### 📖 Introduction

**Gemini Chat Exporter** is an open-source browser extension (for Chrome, Brave, Firefox, and Zen Browser) that allows you to effortlessly archive, browse, and export your Google Gemini conversations. It mirrors the interface and capabilities of `deepseek-exporter`: export the active chat in seconds, trigger a 1-click bulk ZIP export of your entire history, or open a dedicated tab to search, inspect, select, and export conversations.

### ✨ Features

- 📄 **Export Current Chat** - Exports the currently active conversation to JSON, Markdown, or Plain Text in a single click.
- ⚡ **1-Click Bulk History Export** - Scans the Gemini conversation history sidebar (with automated downward scrolling) and packages all conversations into a single `.zip` archive containing individual files.
- 🌐 **Full-Tab Chat Browser (`browse.html`)** - Dedicated full-page viewer modeled after `deepseek-exporter`:
  - Search/filter conversations in real time.
  - Sort by title or ID.
  - Checkboxes for selecting specific subsets of chats (with Shift+Click multi-select and Select All).
  - Individual "Export" and "View" buttons per conversation.
  - "Export Selected (N)" and "Export All" buttons with interactive progress modal.
  - Dark and Light theme toggle.
- 📋 **DeepSeek-Compatible JSON Schema** - Structured JSON output with `conversation_id`, `title`, `url`, `exported_at`, `platform`, `model`, `message_count`, and chronological `messages`.
- 📝 **Multi-Format Support** - JSON, Markdown (`.md`), and Plain Text (`.txt`).
- 🖥️ **Persistent Progress Tracking** - Real-time progress bar both in the extension popup, on-page floating HUD, and in the browse tab modal.
- 🔒 **100% Private & Local** - Zero third-party servers. All processing, scraping, and compression (via `JSZip`) occur locally in your browser.

---

### 🎬 Quick Start

#### Installation in Chrome / Brave / Edge

1. Download or clone this repository:
   ```bash
   git clone https://github.com/gustawdaniel/gemini-chat-exporter.git
   ```
2. Open your browser and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the `apps/gemini-chat-exporter` folder

#### Installation in Zen Browser / Firefox

1. Open Zen Browser or Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `manifest.json` inside `apps/gemini-chat-exporter`

---

### 🚀 Usage

1. Open [Google Gemini](https://gemini.google.com) and ensure you are logged in.
2. Click the **Gemini Chat Exporter** extension icon in your browser toolbar.
3. Choose your workflow:
   - **📄 Export Current chat**: Instantly downloads the chat currently open in the active tab.
   - **⚡ Export All chats**: Initiates automated scanning and downloads a `.zip` archive with all conversations.
   - **🌐 Browse All chats**: Opens the dedicated chat browser tab where you can search, view, select, and export chats with complete visual control.

---

### 📋 JSON Format (Per-Chat Output)

Each conversation is saved as an individual structured JSON file:

```json
{
  "conversation_id": "c_2e59178b02",
  "title": "Quantum Computing & Qubits",
  "url": "https://gemini.google.com/app/c_2e59178b02",
  "exported_at": "2026-09-23T10:45:00.000Z",
  "platform": "gemini",
  "model": "gemini-2.5-pro",
  "message_count": 4,
  "messages": [
    {
      "role": "user",
      "content": "Can you explain quantum superposition?",
      "timestamp": "2026-09-23T10:40:00.000Z",
      "index": 0
    },
    {
      "role": "assistant",
      "content": "Superposition is a fundamental principle of quantum mechanics...",
      "timestamp": "2026-09-23T10:40:05.000Z",
      "index": 1
    }
  ]
}
```

---

### 📁 Project Structure

```
gemini-chat-exporter/
├── manifest.json          # WebExtension Manifest V3 (Chrome & Gecko)
├── jszip.min.js           # Client-side ZIP compression library
├── utils.js               # Shared formatters (JSON, Markdown, Text, Download)
├── content.js             # Core extraction engine, sidebar scanner & DOM navigation
├── popup.html             # Popup UI (Current, All, Browse)
├── popup.js               # Popup user actions and message dispatching
├── browse.html            # Full-page interactive chat browser & search table
├── browse.js              # Search, filter, selective export & progress modal logic
├── styles.css             # Gradient UI and progress bar styles
├── icon16.png             # Extension icons
├── icon48.png
├── icon128.png
├── DELIVERY.md            # Delivery specification and changelog
└── README.md              # Documentation
```

---

### 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
