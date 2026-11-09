# Chrome Extension File Download Troubleshooting & Resolution Guide

## Project Information

- **Project Name**: Gemini Chat Exporter
- **Function**: Export Gemini chat conversations to Markdown or JSON format
- **Date**: 2026-01-11
- **Incident Window**: 2026-01-11 21:00-21:30

---

## Problem Description

### Primary Symptoms

Users exporting chat conversations encountered the following issues:

1. **Garbled / Hexadecimal Filenames**: Downloaded files were named as random UUID / hex strings (e.g., `22f5cc0c-0141-46b3-adba-4126075b24ac`) instead of the intended `gemini-chat-20260111-210000.md`.
2. **File Open Failures**: Clicking the file icon in Chrome's download shelf did not open the file.
3. **Truncated Content**: Files were occasionally partially written.

### Environment

- **Operating System**: macOS
- **Browser**: Google Chrome (Latest release)
- **Extension Version**: 1.0.0
- **Target Host**: gemini.google.com

---

## Diagnostic Investigation

### Phase 1: Initial Diagnosis

#### Hypothesis 1: Character Encoding Corruption
**Attempted Fix**:
- Appended UTF-8 BOM (`\uFEFF`) to the start of the payload.
- Explicitly specified `charset=utf-8` in Blob instantiation.

```javascript
const blob = new Blob(['\uFEFF' + content], { 
  type: `${mimeType};charset=utf-8` 
});
```

**Outcome**: ❌ Failed. Filenames remained random hexadecimal hashes.

---

### Phase 2: Download Mechanism Exploration

#### Hypothesis 2: Popup Context Constraints
**Analysis**:
- Extension popup pages are ephemeral contexts that close on blur.
- Programmatic `<a>` tag click downloads may face security or lifecycle teardown issues.

**Attempted Fix A**: Direct synthetic anchor click in popup:

```javascript
const a = document.createElement('a');
a.href = url;
a.download = filename;
a.click();
```

**Outcome**: ❌ Failed. Filenames still corrupted.

**Attempted Fix B**: Delegating download execution to content script:

```javascript
// popup.js
await chrome.tabs.sendMessage(tab.id, {
  action: 'downloadFile',
  content: content,
  filename: filename
});

// content.js
function downloadFileInPage(content, filename, mimeType) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
}
```

**Outcome**: ❌ Failed. Filenames remained corrupted.

---

### Phase 3: Deep Root Cause Analysis

#### Automated Browser Tracing

Tracing Chrome download manager internals revealed the smoking gun:

> The "garbled filename" observed is a classic symptom of an Object URL (Blob URL) being revoked before Chrome's download manager has committed the stream to disk.

**Key Findings**:
1. **Premature Revocation**: Code utilized `setTimeout(() => URL.revokeObjectURL(url), 1000)`.
2. **Download Manager Latency**: Chrome's download pipeline often requires more than 1 second to:
   - Check antivirus / safe browsing
   - Resolve conflict collisions
   - Allocate and commit disk blocks
3. **Source Lost**: If the Blob URL disappears from memory before disk commitment begins, Chrome falls back to storing whatever temporary memory cache name was assigned.

#### Faulty Code Pattern

```javascript
// ❌ Problematic implementation
const blob = new Blob([content], { type: mimeType });
const url = URL.createObjectURL(blob);

chrome.downloads.download({ url: url, filename: filename });

// Bug: 1000ms delay is arbitrary and often fires before download stream commits
setTimeout(() => URL.revokeObjectURL(url), 1000);
```

---

## Solution

### Final Architecture: Base64 Data URLs

#### Core Rationale

A `data:` URL is a self-contained string. It does not require memory allocation in the Object URL store, requires no revocation lifecycle, and cannot be destroyed prematurely by context unloads.

#### Implementation

```javascript
function downloadWithDataURL(content, filename, mimeType) {
  try {
    // 1. Add UTF-8 BOM
    const BOM = '\uFEFF';
    const contentWithBOM = BOM + content;
    
    // 2. Convert to base64 Data URL safely handling multibyte unicode
    const base64Content = btoa(unescape(encodeURIComponent(contentWithBOM)));
    const dataUrl = `data:${mimeType};charset=utf-8;base64,${base64Content}`;
    
    // 3. Trigger download via Chrome API
    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Download error:', chrome.runtime.lastError);
      } else {
        console.log('Download started successfully with ID:', downloadId);
      }
    });
  } catch (error) {
    console.error('Failed to create data URL:', error);
    alert('Export failed: ' + error.message);
  }
}
```

#### Comparison Matrix

| Property | Blob URL | Data URL |
|----------|----------|----------|
| Revocation Required | ✅ Yes (`revokeObjectURL`) | ❌ No |
| Lifecycle Management | Complex | Trivial |
| Filename Reliability | Fragile | 100% Reliable |
| Optimal Use Case | Large binaries (>20MB) | Text / small files (<10MB) |

---

## Secondary Issues & Fixes

### Issue 2: Content Script Disconnection

#### Error Signature
```
Error: Could not establish connection. Receiving end does not exist.
```

#### Root Cause
- When an extension is reloaded in `chrome://extensions/`, existing open tabs retain orphaned content scripts that can no longer communicate with the new extension runtime ID.

#### Resolution

**Pattern**: Connection Retry Backoff

```javascript
async function sendMessageWithRetry(tabId, message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (error) {
      if (i === maxRetries - 1) {
        throw new Error('Content script not loaded. Please refresh the Gemini page and try again.');
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
```

---

## Key Best Practices

### 1. File Downloads in Chrome Extensions

- **Small to medium files (<10MB)**: Always use Base64 `data:` URLs.
- **Large binary files**: If Blob URLs must be used, listen to `chrome.downloads.onChanged` until `state.current === 'complete'` before revoking the URL.
- **Never** use fixed `setTimeout` delays to revoke Blob URLs.

### 2. UTF-8 Encoding Pipeline

```javascript
const BOM = '\uFEFF';
const content = BOM + rawString;
const base64 = btoa(unescape(encodeURIComponent(content)));
```

---

## Verification & Test Scenarios

1. ✅ **Markdown Export**: Filenames clean, text formatting intact, emojis and international characters render without corruption.
2. ✅ **JSON Export**: Valid JSON schema, ISO timestamps, clean parser output.
3. ✅ **Large Conversations**: Tested on 100+ turns without degradation.
4. ✅ **Code Blocks**: Preserves indentation and syntax highlighting tags.
5. ✅ **Sequential Exports**: Filename collision handles auto-increment `(1)`, `(2)`.

---

## Retrospective Lessons

1. **Avoid Guesswork in Lifecycle Teardown**: Fixed timers (`setTimeout`) around OS/browser I/O operations are an anti-pattern.
2. **Context Boundaries Matter**: The popup UI window has an ephemeral lifecycle; long-lived operations belong in background service workers or self-contained Data URLs.
3. **Structured Error Handling**: Clear end-user instructions ("Please refresh the tab") transform cryptic API errors into actionable fixes.

---

**Status**: ✅ All issues permanently resolved.
