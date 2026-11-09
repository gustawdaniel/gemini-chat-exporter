// Shared utility functions for Gemini Chat Exporter

// Sanitize filename to avoid OS invalid characters
function sanitizeFilename(name) {
  if (!name) return 'gemini-chat';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80);
}

// Generate formatted timestamp string: YYYYMMDD-HHMMSS
function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

// Escape HTML characters
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Convert conversation data to Markdown format
function convertToMarkdown(data, includeMetadata = true, conversationId = null) {
  const title = data.title || 'Gemini Conversation';
  const id = conversationId || data.conversation_id || 'unknown';
  const messages = data.messages || [];

  let md = `# ${title}\n\n`;

  if (includeMetadata) {
    md += `- **Conversation ID**: \`${id}\`\n`;
    md += `- **Platform**: Google Gemini\n`;
    md += `- **Model**: ${data.model || 'gemini-2.5-pro'}\n`;
    md += `- **Export Date**: ${data.exported_at || new Date().toISOString()}\n`;
    if (data.url) {
      md += `- **Link**: [${data.url}](${data.url})\n`;
    }
    md += `- **Message Count**: ${messages.length}\n\n`;
    md += `---\n\n`;
  }

  messages.forEach((msg, idx) => {
    const role = msg.role === 'user' ? '## 👤 User' : '## 🤖 Gemini';
    md += `${role}\n\n`;

    if (includeMetadata && msg.timestamp) {
      md += `*${msg.timestamp}*\n\n`;
    }

    if (msg.content) {
      md += `${msg.content}\n\n`;
    }

    if (idx < messages.length - 1) {
      md += `---\n\n`;
    }
  });

  return md;
}

// Convert conversation data to Plain Text format
function convertToText(data, includeMetadata = true) {
  const title = data.title || 'Gemini Conversation';
  const messages = data.messages || [];
  let text = '';

  if (includeMetadata) {
    text += `${title}\n`;
    text += `Conversation ID: ${data.conversation_id || 'unknown'}\n`;
    text += `Export Date: ${data.exported_at || new Date().toISOString()}\n`;
    text += `Platform: Google Gemini\n`;
    text += `----------------------------------------\n\n`;
  }

  messages.forEach(msg => {
    const sender = msg.role === 'user' ? 'User' : 'Gemini';
    text += `[${sender}]:\n${msg.content || ''}\n\n`;
  });

  return text.trim();
}

// Convert conversation data to JSON format
function convertToJson(data) {
  const output = {
    conversation_id: data.conversation_id || data.id || 'unknown',
    title: data.title || 'Gemini Chat',
    url: data.url || `https://gemini.google.com/app/${data.conversation_id || ''}`,
    exported_at: data.exported_at || new Date().toISOString(),
    platform: 'gemini',
    model: data.model || 'gemini-2.5-pro',
    message_count: (data.messages || []).length,
    messages: (data.messages || []).map((msg, index) => ({
      role: msg.role || 'user',
      content: msg.content || '',
      timestamp: msg.timestamp || new Date().toISOString(),
      index: typeof msg.index === 'number' ? msg.index : index
    }))
  };

  return JSON.stringify(output, null, 2);
}

// Download file utility (supports Data URL & Blob URL fallback)
function downloadFile(content, filename, mimeType = 'application/json') {
  try {
    const BOM = '\uFEFF';
    const contentWithBOM = BOM + content;

    const blob = new Blob([contentWithBOM], { type: `${mimeType};charset=utf-8` });
    const blobUrl = URL.createObjectURL(blob);

    if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.download) {
      chrome.downloads.download({
        url: blobUrl,
        filename: filename,
        saveAs: false,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.warn('chrome.downloads failed, falling back to anchor download:', chrome.runtime.lastError);
          fallbackAnchorDownload(blobUrl, filename);
        } else {
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        }
      });
    } else {
      fallbackAnchorDownload(blobUrl, filename);
    }
  } catch (error) {
    console.error('downloadFile error:', error);
    // Base64 Data URL fallback
    try {
      const base64Content = btoa(unescape(encodeURIComponent('\uFEFF' + content)));
      const dataUrl = `data:${mimeType};charset=utf-8;base64,${base64Content}`;
      fallbackAnchorDownload(dataUrl, filename);
    } catch (e2) {
      alert('Download failed: ' + error.message);
    }
  }
}

function fallbackAnchorDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    if (url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }, 1000);
}
