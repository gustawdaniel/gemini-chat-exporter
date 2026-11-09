// Popup script for Gemini Chat Exporter

document.addEventListener('DOMContentLoaded', () => {
  // Update version from manifest
  try {
    const versionElem = document.getElementById('header-version');
    if (versionElem && typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      versionElem.textContent = 'v' + chrome.runtime.getManifest().version;
    }
  } catch (_) {}

  const formatSelect = document.getElementById('format');
  const includeChatsCheckbox = document.getElementById('includeChats');
  const includeMetadataCheckbox = document.getElementById('includeMetadata');
  const autoScrollSidebarCheckbox = document.getElementById('autoScrollSidebar');

  const exportCurrentBtn = document.getElementById('exportCurrent') || document.getElementById('exportSingleBtn') || document.getElementById('exportBtn');
  const exportAllBtn = document.getElementById('exportAll') || document.getElementById('exportAllBtn');
  const browseChatsBtn = document.getElementById('browsechats') || document.getElementById('browseChatsBtn');
  const statusEl = document.getElementById('status');

  // Status indicator helper
  function showStatus(message, type = 'info', autoHide = false) {
    if (!statusEl) return;
    statusEl.className = `status show ${type}`;
    statusEl.textContent = message;

    if (autoHide && type === 'success') {
      setTimeout(() => {
        statusEl.className = 'status';
        statusEl.textContent = '';
      }, 3500);
    }
  }

  // Checkbox dependencies (lock metadata & chat if JSON)
  function updateCheckboxStates() {
    if (!formatSelect) return;
    const isJson = formatSelect.value === 'json';

    if (includeChatsCheckbox) {
      includeChatsCheckbox.disabled = isJson;
      if (isJson) includeChatsCheckbox.checked = true;
    }
    if (includeMetadataCheckbox) {
      includeMetadataCheckbox.disabled = isJson;
      if (isJson) includeMetadataCheckbox.checked = true;
    }
  }

  if (formatSelect) {
    formatSelect.addEventListener('change', updateCheckboxStates);
    updateCheckboxStates();
  }

  // Get active Gemini tab or any open Gemini tab
  async function getGeminiTab() {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url && activeTab.url.includes('gemini.google.com')) {
      return activeTab;
    }
    const allTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (allTabs && allTabs.length > 0) {
      return allTabs[0];
    }
    return null;
  }

  // Send message to content script with retry and timeout
  async function sendMessageWithRetry(tabId, message, maxRetries = 3, timeoutMs = 12000) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        console.log(`[Gemini Exporter Popup] Wysyłanie polecenia do karty ${tabId} (próba ${i + 1}/${maxRetries}):`, message);
        const response = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Timeout: brak odpowiedzi od karty Gemini po ${timeoutMs / 1000}s`));
          }, timeoutMs);

          chrome.tabs.sendMessage(tabId, message, (res) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(res);
            }
          });
        });
        return response;
      } catch (err) {
        console.warn(`[Gemini Exporter Popup] Próba ${i + 1} nie powiodła się: ${err.message}`);
        if (i === maxRetries - 1) throw err;
        await new Promise(r => setTimeout(r, 400));
      }
    }
  }

  // Listen for background progress from bulk exports
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'bulkProgress') {
      if (msg.phase === 'scanning') {
        showStatus(`Scanning history: found ${msg.count} chats...`, 'info');
      } else if (msg.phase === 'exporting') {
        showStatus(`Exporting [${msg.current}/${msg.total}] ${msg.title || ''}`, 'info');
      }
    } else if (msg.action === 'bulkComplete') {
      showStatus(`🎉 Exported ${msg.exportedCount} chats to ZIP!`, 'success', true);
      if (exportAllBtn) exportAllBtn.disabled = false;
      if (exportCurrentBtn) exportCurrentBtn.disabled = false;
    }
  });

  // ---- 1. Export Current Chat ----
  if (exportCurrentBtn) {
    exportCurrentBtn.addEventListener('click', async () => {
      exportCurrentBtn.disabled = true;
      showStatus('Fetching current chat...', 'info');

      try {
        const tab = await getGeminiTab();
        if (!tab) {
          throw new Error('Please open https://gemini.google.com first.');
        }

        const response = await sendMessageWithRetry(tab.id, { action: 'extractMessages' });

        if (!response || !response.success || !response.messages || response.messages.length === 0) {
          throw new Error('No chat messages found in active Gemini tab.');
        }

        const format = formatSelect ? formatSelect.value : 'json';
        const includeMetadata = includeMetadataCheckbox ? includeMetadataCheckbox.checked : true;
        const title = response.title || 'Gemini Chat';
        const conversationId = response.conversationId || 'unknown';
        const safeTitle = sanitizeFilename(title);

        const chatData = {
          conversation_id: conversationId,
          title: title,
          url: tab.url,
          exported_at: new Date().toISOString(),
          platform: 'gemini',
          model: 'gemini-2.5-pro',
          message_count: response.messages.length,
          messages: response.messages
        };

        let content, filename, mimeType;
        if (format === 'markdown') {
          content = convertToMarkdown(chatData, includeMetadata, conversationId);
          filename = `${safeTitle}.md`;
          mimeType = 'text/markdown';
        } else if (format === 'text') {
          content = convertToText(chatData, includeMetadata);
          filename = `${safeTitle}.txt`;
          mimeType = 'text/plain';
        } else {
          content = convertToJson(chatData);
          filename = `${safeTitle}.json`;
          mimeType = 'application/json';
        }

        downloadFile(content, filename, mimeType);
        showStatus(`Exported "${safeTitle}"!`, 'success', true);

      } catch (err) {
        console.error('Export current error:', err);
        showStatus(err.message || 'Export failed', 'error');
      } finally {
        exportCurrentBtn.disabled = false;
      }
    });
  }

  // ---- 2. Export All Chats (Opens Browse dashboard with full features) ----
  if (exportAllBtn) {
    exportAllBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') });
      window.close();
    });
  }

  // ---- 3. Browse All Chats ----
  if (browseChatsBtn) {
    browseChatsBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') });
    });
  }
});
