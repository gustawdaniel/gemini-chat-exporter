// Browse Page Logic for Gemini Chat Exporter

let allConversations = [];
let filteredConversations = [];
// Default to sidebar chronological order (index 0 = most recent, same as Gemini sidebar)
let sortStack = [{ field: 'order', direction: 'asc' }];
let selectedConversations = new Set();
let lastCheckedIndex = null;
let cachedChatMap = new Map(); // id -> { message_count, cached_at, title }
let failedSessionsMap = new Map(); // id -> error message
let currentFilterTab = 'all'; // 'all' | 'uncached' | 'cached' | 'failed'

async function refreshCachedMap() {
  try {
    if (typeof getCachedChatMap === 'function') {
      cachedChatMap = await getCachedChatMap();
      updateCacheBadgeUI();
      updateFilterTabCounts();
    }
  } catch (e) {
    console.warn('[Gemini Exporter] Could not read IndexedDB cache:', e);
  }
}

function updateCacheBadgeUI() {
  const badge = document.getElementById('cachedCountBadge');
  const btn = document.getElementById('exportCachedBtn');
  const count = cachedChatMap.size;
  if (badge) badge.textContent = count;
  if (btn) btn.style.display = count > 0 ? 'inline-flex' : 'none';
  updateStats();
}

// ---- Theme Handling ----

function initTheme() {
  const saved = localStorage.getItem('gemini-exporter-theme');
  const sunIcon = document.querySelector('.sun-icon');
  const moonIcon = document.querySelector('.moon-icon');

  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon(saved, sunIcon, moonIcon);
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    updateThemeIcon(prefersDark ? 'dark' : 'light', sunIcon, moonIcon);
  }
}

function updateThemeIcon(theme, sunIcon, moonIcon) {
  if (!sunIcon || !moonIcon) return;
  if (theme === 'dark') {
    sunIcon.style.display = 'none';
    moonIcon.style.display = 'block';
  } else {
    sunIcon.style.display = 'block';
    moonIcon.style.display = 'none';
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const sunIcon = document.querySelector('.sun-icon');
  const moonIcon = document.querySelector('.moon-icon');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const newTheme = current ? (current === 'dark' ? 'light' : 'dark') : (prefersDark ? 'light' : 'dark');

  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('gemini-exporter-theme', newTheme);
  updateThemeIcon(newTheme, sunIcon, moonIcon);
}

// ---- Logging & Console Diagnostics ----

const EXTENSION_VERSION = 'v1.3.0';
let isExportCancelled = false;
const diagnosticLogBuffer = [];

function logProgress(message, level = 'info') {
  const now = new Date();
  const timeStr = now.toTimeString().substring(0, 8);
  const logMsg = `[${timeStr}] ${message}`;

  diagnosticLogBuffer.push(logMsg);
  if (diagnosticLogBuffer.length > 2000) diagnosticLogBuffer.shift();

  // Styled console output for browser DevTools (F12)
  const style = level === 'error'
    ? 'color: #ef4444; font-weight: bold;'
    : level === 'warn'
    ? 'color: #f59e0b; font-weight: bold;'
    : level === 'success'
    ? 'color: #10b981; font-weight: bold;'
    : 'color: #6366f1; font-weight: 500;';

  console.log(`%c[Gemini Exporter] [${EXTENSION_VERSION}] ${logMsg}`, style);

  // Forward to local diagnostic server on port 3040
  try {
    fetch('http://localhost:3040/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'browse',
        version: EXTENSION_VERSION,
        level,
        message: `[${EXTENSION_VERSION}] ${logMsg}`
      })
    }).catch(() => {});
  } catch (_) {}

  // UI Modal log output
  const logBox = document.getElementById('progressLog');
  if (logBox) {
    const line = document.createElement('div');
    line.style.marginBottom = '3px';
    if (level === 'error') line.style.color = 'var(--error-color, #ef4444)';
    else if (level === 'success') line.style.color = '#10b981';
    else if (level === 'warn') line.style.color = '#f59e0b';

    line.textContent = logMsg;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  // Update status subtext in modal
  const statusLine = document.getElementById('progressCurrentStatus');
  if (statusLine) {
    statusLine.textContent = message;
  }
}

// ---- Gemini Tab Management & Navigation ----

async function getOrFindGeminiTab() {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (!tabs || tabs.length === 0) {
    return null;
  }
  const active = tabs.find(t => t.active);
  return active || tabs[0];
}

async function navigateGeminiTab(tabId, targetUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let finished = false;

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup();
        logProgress(`Strona Gemini załadowana (status complete). Oczekiwanie 800ms na framework...`);
        setTimeout(() => resolve(tab), 800);
      }
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      finished = true;
    };

    timer = setTimeout(() => {
      if (!finished) {
        cleanup();
        logProgress(`⚠️ Przekroczono limit czasu oczekiwania na załadowanie karty (${timeoutMs / 1000}s). Próba kontynuacji...`, 'warn');
        resolve(null);
      }
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.update(tabId, { url: targetUrl }).catch(err => {
      cleanup();
      reject(err);
    });
  });
}

async function sendMessageWithTimeout(tabId, message, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      reject(new Error(`Timeout: brak odpowiedzi od karty Gemini po ${timeoutMs / 1000}s`));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve(response);
      } else {
        reject(new Error(response?.error || 'Nieznany błąd odpowiedzi z karty Gemini'));
      }
    });
  });
}

// Fallback message dispatcher across Gemini tabs
async function sendMessageToGeminiTab(action, data = {}, timeoutMs = 25000) {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (!tabs || tabs.length === 0) {
    throw new Error('Please open https://gemini.google.com in your browser first, then reload this page.');
  }

  for (const tab of tabs) {
    try {
      return await sendMessageWithTimeout(tab.id, { action, ...data }, timeoutMs);
    } catch (e) {
      if (e.message.includes('Could not establish connection') || e.message.includes('Receiving end does not exist')) {
        continue;
      }
      throw e;
    }
  }

  throw new Error('Could not communicate with the Gemini tab. Please refresh your Gemini tab and try again.');
}

// ---- Progress Banner Controls ----

function showScanBanner(text, countText, percent = null) {
  const banner = document.getElementById('scanProgressBarContainer');
  const txt = document.getElementById('scanProgressText');
  const cnt = document.getElementById('scanProgressCount');
  const fill = document.getElementById('scanProgressBarFill');

  if (banner) banner.style.display = 'block';
  if (txt && text) txt.textContent = text;
  if (cnt && countText) cnt.textContent = countText;
  if (fill && percent !== null) fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

function hideScanBanner(delayMs = 0) {
  setTimeout(() => {
    const banner = document.getElementById('scanProgressBarContainer');
    if (banner) banner.style.display = 'none';
  }, delayMs);
}

// ---- Load Conversations ----

// ---- Load Conversations ----

async function loadConversations(forceRescan = false) {
  const tableContent = document.getElementById('tableContent');

  // 1. Immediately load cache from IndexedDB
  await refreshCachedMap();

  // 2. Pre-load any previously discovered conversations from IndexedDB
  if (typeof getAllDiscoveredSessionsFromDB === 'function') {
    try {
      const dbSessions = await getAllDiscoveredSessionsFromDB();
      if (dbSessions && Array.isArray(dbSessions) && dbSessions.length > 0) {
        allConversations = dbSessions;
        applyFiltersAndSort();
        logProgress(`Wczytano listę ${dbSessions.length} rozmów (w bazie treści: ${cachedChatMap.size}/${dbSessions.length}).`);
      }
    } catch (e) {
      console.warn('[Gemini Exporter] Błąd odczytu bazy sessions:', e);
    }
  }

  // 3. Pre-load any existing cached conversations from chrome.storage.local
  try {
    const cached = await chrome.storage.local.get('geminiSessionList');
    if (cached.geminiSessionList && cached.geminiSessionList.length > allConversations.length) {
      allConversations = cached.geminiSessionList;
      applyFiltersAndSort();
    }
  } catch (_) {}

  // If no cached chats exist yet, display rich dynamic loading view with live counters
  if (allConversations.length === 0) {
    tableContent.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:70px 20px; text-align:center;">
        <div class="spinner" style="width:44px; height:44px; border-width:4px; margin-bottom:18px;"></div>
        <h3 id="initialScanHeading" style="font-size:17px; font-weight:700; color:var(--text-primary); margin-bottom:8px;">Skanowanie paska historii Gemini...</h3>
        <p id="initialScanSubtext" style="font-size:13px; color:var(--text-secondary); max-width:500px; margin-bottom:16px;">Przewijanie bocznego paska w poszukiwaniu wszystkich rozmów z Twojego konta.</p>
        <div style="display:inline-flex; gap:16px; align-items:center; font-size:13px; font-weight:600; color:var(--primary-color); background:var(--secondary-bg); padding:7px 18px; border-radius:20px; margin-bottom:20px; border:1px solid var(--border-color);">
          <span id="initialFoundCount">Znaleziono: 0 czatów</span>
          <span>•</span>
          <span id="initialStepCount">Krok: 1 / 400</span>
        </div>
        <div>
          <button id="initialStopBtn" style="padding:7px 16px; font-size:12px; font-weight:600; background:#ef4444; color:white; border:none; border-radius:6px; cursor:pointer;" title="Zatrzymaj dalsze przewijanie i natychmiast wyświetl dotychczas znalezione czaty">🛑 Zatrzymaj i pokaż to co wykryto</button>
        </div>
      </div>
    `;
    document.getElementById('exportAllBtn').disabled = true;

    const stopBtn = document.getElementById('initialStopBtn');
    if (stopBtn) {
      stopBtn.onclick = () => {
        logProgress('Użytkownik zatrzymał początkowe skanowanie.');
        sendMessageToGeminiTab('stopScan', {}, 2000).catch(() => {});
        chrome.storage.local.get('geminiSessionList').then(store => {
          if (store.geminiSessionList && store.geminiSessionList.length > 0) {
            allConversations = store.geminiSessionList;
            applyFiltersAndSort();
          }
        });
      };
    }
  }

  showScanBanner('🔄 Łączenie z kartą Gemini...', `${allConversations.length} czatów w bazie`, 20);

  // 4. Send non-blocking request to start background discovery in Gemini tab
  try {
    const autoScroll = document.getElementById('autoScrollSidebar')?.checked !== false;
    const response = await sendMessageToGeminiTab('loadConversations', { autoScroll }, 6000);

    if (response && response.sessions && response.sessions.length > allConversations.length) {
      allConversations = response.sessions;
      applyFiltersAndSort();
    }

    showScanBanner('🔄 Przewijanie i skanowanie historii Gemini...', `${allConversations.length} czatów`, 30);
  } catch (error) {
    console.warn('Live tab query note:', error.message);
    if (allConversations.length === 0) {
      showError(error.message);
    } else {
      showScanBanner('ℹ️ Załadowano zapisaną historię z pamięci podręcznej', `${allConversations.length} czatów`, 100);
      hideScanBanner(3500);
    }
  }
}

// Listen for runtime streaming messages from content.js (real-time progress)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'diagnosticLog') {
    try {
      if (!request.version) request.version = EXTENSION_VERSION;
      fetch('http://localhost:3040/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      }).catch(() => {});
    } catch (_) {}
    return;
  }

  if (request.action === 'cancelExportFromHUD') {
    isExportCancelled = true;
    logProgress('🛑 Użytkownik kliknął Anuluj na widżecie Gemini. Kończenie aktualnego czatu i pakowanie ZIP...', 'warn');
    const progressBadge = document.getElementById('progressBadge');
    if (progressBadge) {
      progressBadge.textContent = 'Zatrzymywanie...';
      progressBadge.style.color = '#ef4444';
    }
    return;
  }

  if (request.action === 'extractProgress') {
    const { status, sessionId } = request;
    const progressText = document.getElementById('progressText');
    if (progressText && status) {
      progressText.textContent = status;
    }
    if (status) {
      logProgress(`ℹ️ [${sessionId || 'karta'}] ${status}`);
    }
    return;
  }

  if (request.action === 'scanProgress') {
    const { count, waitingForNetwork, retry, maxRetries, section, step, maxSteps, latestTitle, newItems } = request;

    let bannerText = `🔄 Skanowanie paska: krok ${step || 1}/${maxSteps || 400} (${section || 'Rozmowy'})`;
    if (latestTitle) {
      bannerText += ` — "${latestTitle.substring(0, 30)}..."`;
    }
    if (waitingForNetwork) {
      bannerText = `⏳ Pobieranie starszych czatów z serwera Google (${retry}/${maxRetries})...`;
    }

    const countText = `${count} czatów (+${newItems || 0})`;
    const pct = step && maxSteps ? Math.min(95, Math.round((step / maxSteps) * 100)) : null;

    showScanBanner(bannerText, countText, pct);

    // Update initial loading card if still shown
    const foundEl = document.getElementById('initialFoundCount');
    const stepEl = document.getElementById('initialStepCount');
    const headEl = document.getElementById('initialScanHeading');
    const subEl = document.getElementById('initialScanSubtext');
    if (foundEl) foundEl.textContent = `Znaleziono: ${count} czatów`;
    if (stepEl && step && maxSteps) stepEl.textContent = `Krok: ${step} / ${maxSteps}`;
    if (headEl && section) headEl.textContent = `Skanowanie: ${section}...`;
    if (subEl && latestTitle) subEl.textContent = `Ostatnio wykryty: "${latestTitle}"`;

    // As soon as at least 1 conversation is found, IMMEDIATELY switch to table view!
    chrome.storage.local.get('geminiSessionList').then(store => {
      if (store.geminiSessionList && store.geminiSessionList.length > 0) {
        if (store.geminiSessionList.length > allConversations.length || allConversations.length === 0) {
          allConversations = store.geminiSessionList;
          applyFiltersAndSort();
        }
      }
    }).catch(() => {});
  } else if (request.action === 'scanComplete') {
    const count = request.count || allConversations.length;
    showScanBanner('✅ Zsynchronizowano pełną historię czatów!', `${count} czatów`, 100);
    hideScanBanner(4000);

    if (request.sessions && request.sessions.length > 0) {
      allConversations = request.sessions;
      applyFiltersAndSort();
      if (typeof saveDiscoveredSessionsToDB === 'function') {
        saveDiscoveredSessionsToDB(request.sessions).catch(() => {});
      }
    }
  }
});

// Listen for storage changes across extension tabs
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.geminiSessionList) {
    const newList = changes.geminiSessionList.newValue;
    if (newList && Array.isArray(newList) && newList.length > allConversations.length) {
      allConversations = newList;
      applyFiltersAndSort();
      if (typeof saveDiscoveredSessionsToDB === 'function') {
        saveDiscoveredSessionsToDB(newList).catch(() => {});
      }
    }
  }
});

// ---- Filtering and Sorting ----

// ---- Formatting & Row Rendering Helpers ----

function formatTimeOrSection(session, cachedInfo) {
  if (cachedInfo && cachedInfo.cached_at) {
    const d = new Date(cachedInfo.cached_at);
    if (!isNaN(d.getTime())) {
      const pad = n => String(n).padStart(2, '0');
      const dateStr = `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return `<span style="font-size:11px; font-weight:500; color:var(--text-secondary);" title="Zsynchronizowano w lokalnej bazie:\n${d.toLocaleString()}">🕒 ${dateStr}</span>`;
    }
  }

  const orderNum = session.order !== undefined ? session.order + 1 : 999;
  if (session.section && session.section !== 'Rozmowa' && session.section !== 'Ostatnie') {
    return `<span style="font-size:11px; font-weight:500; color:var(--text-secondary); background:var(--secondary-bg); padding:2px 6px; border-radius:4px; border:1px solid var(--border-color);">${escapeHtml(session.section)}</span>`;
  }

  if (orderNum <= 5) {
    return `<span style="font-size:11px; font-weight:600; color:#10b981;" title="Pozycja #${orderNum} w pasku Gemini (najnowsza aktywność)">🟢 Najnowszy</span>`;
  } else if (orderNum <= 25) {
    return `<span style="font-size:11px; font-weight:500; color:var(--text-secondary);" title="Pozycja #${orderNum} w pasku Gemini">🕒 Niedawny</span>`;
  } else {
    return `<span style="font-size:11px; color:var(--text-muted);" title="Pozycja #${orderNum} w pasku Gemini">📜 Historia</span>`;
  }
}

function formatCacheStatus(session, cachedInfo, errorMsg = null) {
  if (cachedInfo) {
    const d = cachedInfo.cached_at ? new Date(cachedInfo.cached_at).toLocaleString() : '';
    return `<span class="badge-cached" title="Zapisano w bazie IndexedDB:\n${cachedInfo.message_count} wiadomości\nData: ${d}">💾 ${cachedInfo.message_count} wiad.</span>`;
  }
  if (errorMsg) {
    return `<span class="badge-error" title="Błąd pobierania: ${escapeHtml(errorMsg)}">❌ Błąd</span>`;
  }
  return `<span class="badge-pending" title="Czat jeszcze nie został pobrany do bazy">⏳ Do pobrania</span>`;
}

let currentViewerChat = null;

async function openChatViewer(sessionId) {
  const modal = document.getElementById('chatViewerModal');
  const titleEl = document.getElementById('viewerChatTitle');
  const metaEl = document.getElementById('viewerChatMeta');
  const dateEl = document.getElementById('viewerChatDate');
  const linkEl = document.getElementById('viewerGeminiLink');
  const container = document.getElementById('viewerMessagesContainer');

  if (!modal) return;
  modal.style.display = 'block';

  const session = allConversations.find(s => s.id === sessionId) || { id: sessionId, title: 'Rozmowa' };
  titleEl.textContent = session.title || session.id;
  linkEl.href = session.url || `https://gemini.google.com/app/${sessionId}`;
  metaEl.textContent = 'Ładowanie wiadomości...';
  dateEl.textContent = '';
  container.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted); font-size:14px;">⏳ Wczytywanie wiadomości z lokalnej bazy IndexedDB...</div>';

  try {
    let chat = null;
    if (typeof getChatFromDB === 'function') {
      chat = await getChatFromDB(sessionId);
    }

    currentViewerChat = chat;

    if (!chat || !chat.messages || chat.messages.length === 0) {
      metaEl.textContent = '0 wiadomości w bazie';
      container.innerHTML = `
        <div style="text-align:center; padding:60px 20px; color:var(--text-muted);">
          <div style="font-size:42px; margin-bottom:14px;">📭</div>
          <h3 style="margin:0 0 8px 0; color:var(--text-primary); font-size:16px;">Brak pobranych wiadomości w lokalnej bazie</h3>
          <p style="margin:0 0 24px 0; font-size:13px; max-width:440px; margin-left:auto; margin-right:auto; line-height:1.5;">
            Ta rozmowa jest wykryta na liście, ale jej pełna treść nie została jeszcze pobrana do IndexedDB.
          </p>
          <div style="display:flex; justify-content:center; gap:12px;">
            <button id="viewerFetchNowBtn" class="btn-primary" style="padding:8px 18px; font-size:12px; cursor:pointer;">
              ⚡ Pobierz ten czat teraz z karty Gemini
            </button>
            <a href="${linkEl.href}" target="_blank" class="btn-secondary" style="padding:8px 18px; font-size:12px; text-decoration:none; display:inline-flex; align-items:center; cursor:pointer;">
              Otwórz w Gemini ↗
            </a>
          </div>
        </div>
      `;
      const fetchBtn = document.getElementById('viewerFetchNowBtn');
      if (fetchBtn) {
        fetchBtn.onclick = async () => {
          fetchBtn.disabled = true;
          fetchBtn.textContent = 'Pobieranie wiadomości...';
          await exportSingle(sessionId, session.title, fetchBtn);
          openChatViewer(sessionId);
        };
      }
      return;
    }

    const msgCount = chat.messages.length;
    metaEl.textContent = `${msgCount} wiadomości w historii`;
    dateEl.textContent = chat.exported_at ? `Zsynchronizowano: ${new Date(chat.exported_at).toLocaleString()}` : '';

    let html = '';

    chat.messages.forEach((msg, idx) => {
      const isUser = msg.role === 'user';
      const roleBadge = isUser
        ? '<span style="font-size:11px; font-weight:700; color:#4338ca; background:#e0e7ff; padding:2px 8px; border-radius:10px;">👤 Użytkownik</span>'
        : '<span style="font-size:11px; font-weight:700; color:#065f46; background:#d1fae5; padding:2px 8px; border-radius:10px;">🤖 Gemini</span>';

      const bg = isUser ? 'var(--secondary-bg)' : 'var(--bg-primary)';
      const border = isUser ? '1px solid #c7d2fe' : '1px solid var(--border-color)';

      html += `
        <div style="background:${bg}; border:${border}; border-radius:10px; padding:16px 20px; box-shadow:0 1px 3px rgba(0,0,0,0.04);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid rgba(0,0,0,0.06); padding-bottom:6px;">
            <div style="display:flex; align-items:center; gap:8px;">
              ${roleBadge}
              <span style="font-size:11px; color:var(--text-muted); font-weight:600;">Wiadomość #${idx + 1}</span>
            </div>
            <button class="btn-copy-msg" data-index="${idx}" style="background:var(--bg-primary); border:1px solid var(--border-color); border-radius:5px; padding:3px 9px; font-size:11px; cursor:pointer; color:var(--text-secondary); transition:all 0.15s;" title="Kopiuj treść tej wiadomości">📋 Kopiuj</button>
          </div>
          <div class="message-text" style="font-size:13.5px; line-height:1.65; color:var(--text-primary); white-space:pre-wrap; word-break:break-word; font-family:inherit; user-select:text;">${escapeHtml(msg.content)}</div>
        </div>
      `;
    });

    container.innerHTML = html;

    container.querySelectorAll('.btn-copy-msg').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.index, 10);
        const msg = chat.messages[idx];
        if (msg && msg.content) {
          navigator.clipboard.writeText(msg.content);
          btn.textContent = '✅ Skopiowano!';
          setTimeout(() => { btn.textContent = '📋 Kopiuj'; }, 2000);
        }
      };
    });

  } catch (err) {
    container.innerHTML = `<div style="padding:30px; text-align:center; color:#ef4444;">Błąd odczytu z bazy IndexedDB: ${escapeHtml(err.message)}</div>`;
  }
}

function renderRowActions(session, cachedInfo, errorMsg = null) {
  const safeId = escapeHtml(session.id);
  const safeTitle = escapeHtml(session.title || 'Gemini Conversation');
  const chatUrl = escapeHtml(session.url || `https://gemini.google.com/app/${session.id}`);

  let html = `
    <button class="btn-small btn-view-chat" data-id="${safeId}" style="background:var(--primary-color); color:white;" title="Przeglądaj treść tej rozmowy w lokalnej bazie">👁️ Podgląd</button>
    <button class="btn-small btn-export" data-id="${safeId}" data-title="${safeTitle}" title="Eksportuj ten czat do pliku">Export</button>
  `;

  if (errorMsg) {
    html += `<button class="btn-small btn-retry-single" data-id="${safeId}" data-title="${safeTitle}" style="background:#ef4444; color:white;" title="Ponów próbę pobrania tego czatu">🔁</button>`;
  } else if (cachedInfo) {
    const btnStyle = 'background:var(--secondary-bg); color:var(--text-secondary); border:1px solid var(--border-color);';
    const btnTitle = 'Pobierz ponownie z karty i zaktualizuj bazę (np. po dopisaniu nowych wiadomości)';
    html += `<button class="btn-small btn-refresh-single" data-id="${safeId}" data-title="${safeTitle}" style="${btnStyle}" title="${btnTitle}">🔄</button>`;
  }

  return html;
}

function attachRowActionListeners(scope = document) {
  scope.querySelectorAll('.btn-view-chat').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openChatViewer(btn.dataset.id);
    };
  });

  scope.querySelectorAll('.open-chat-viewer-link').forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openChatViewer(link.dataset.id);
    };
  });

  scope.querySelectorAll('.btn-export').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      exportSingle(btn.dataset.id, btn.dataset.title, btn);
    };
  });

  scope.querySelectorAll('.btn-retry-single').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      exportSingle(btn.dataset.id, btn.dataset.title, btn);
    };
  });

  scope.querySelectorAll('.btn-refresh-single').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      exportSingle(btn.dataset.id, btn.dataset.title, btn);
    };
  });
}

function updateTableRowUI(sessionId, errorMsg = null) {
  const row = document.querySelector(`tr[data-id="${sessionId}"]`);
  const session = allConversations.find(c => c.id === sessionId);
  const cachedInfo = cachedChatMap.get(sessionId);

  if (row && session) {
    const timeCell = row.querySelector('.col-time');
    if (timeCell) timeCell.innerHTML = formatTimeOrSection(session, cachedInfo);

    const cacheCell = row.querySelector('.col-cache');
    if (cacheCell) cacheCell.innerHTML = formatCacheStatus(session, cachedInfo, errorMsg);

    const actionsCell = row.querySelector('.col-actions');
    if (actionsCell) {
      actionsCell.innerHTML = renderRowActions(session, cachedInfo, errorMsg);
      attachRowActionListeners(actionsCell);
    }
  }

  updateFilterTabCounts();
}

function updateFilterTabCounts() {
  const countAll = allConversations.length;
  const countCached = cachedChatMap.size;
  const countUncached = Math.max(0, countAll - countCached);
  const countFailed = failedSessionsMap.size;

  const elAll = document.getElementById('countAll');
  const elCached = document.getElementById('countCached');
  const elUncached = document.getElementById('countUncached');
  const elFailed = document.getElementById('countFailed');

  const tabFailed = document.getElementById('tabFailed');

  const syncMissingBtn = document.getElementById('syncMissingBtn');
  const syncMissingCount = document.getElementById('syncMissingCount');
  const retryFailedBtn = document.getElementById('retryFailedBtn');
  const retryFailedCount = document.getElementById('retryFailedCount');

  if (elAll) elAll.textContent = countAll;
  if (elCached) elCached.textContent = countCached;
  if (elUncached) elUncached.textContent = countUncached;
  if (elFailed) elFailed.textContent = countFailed;

  if (tabFailed) tabFailed.style.display = countFailed > 0 ? 'inline-flex' : 'none';

  if (syncMissingCount) syncMissingCount.textContent = countUncached;
  if (syncMissingBtn) syncMissingBtn.style.display = countUncached > 0 ? 'inline-flex' : 'none';

  if (retryFailedCount) retryFailedCount.textContent = countFailed;
  if (retryFailedBtn) retryFailedBtn.style.display = countFailed > 0 ? 'inline-flex' : 'none';

  updateStats();
  updateExportButtonText();
}

// ---- Filtering and Sorting ----

function applyFiltersAndSort() {
  const searchTerm = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();

  // 1. Filter by active tab
  let list = allConversations.slice();
  if (currentFilterTab === 'uncached') {
    list = list.filter(s => !cachedChatMap.has(s.id));
  } else if (currentFilterTab === 'cached') {
    list = list.filter(s => cachedChatMap.has(s.id));
  } else if (currentFilterTab === 'failed') {
    list = list.filter(s => failedSessionsMap.has(s.id));
  }

  // 2. Filter by search term
  filteredConversations = list.filter(session => {
    return !searchTerm ||
      (session.title && session.title.toLowerCase().includes(searchTerm)) ||
      (session.section && session.section.toLowerCase().includes(searchTerm)) ||
      (session.id && session.id.toLowerCase().includes(searchTerm));
  });

  sortConversations();
  lastCheckedIndex = null;
  displayConversations();
  updateFilterTabCounts();
  updateStats();
}

function sortConversations() {
  filteredConversations.sort((a, b) => {
    for (const { field, direction } of sortStack) {
      let aVal, bVal;

      if (field === 'order') {
        aVal = typeof a.order === 'number' ? a.order : 999999;
        bVal = typeof b.order === 'number' ? b.order : 999999;
        const cmp = aVal - bVal;
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
      } else if (field === 'title') {
        aVal = (a.title || '').toLowerCase();
        bVal = (b.title || '').toLowerCase();
        const cmp = aVal.localeCompare(bVal);
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
      } else if (field === 'section') {
        const aCached = cachedChatMap.get(a.id);
        const bCached = cachedChatMap.get(b.id);
        const aTime = aCached && aCached.cached_at ? new Date(aCached.cached_at).getTime() : 0;
        const bTime = bCached && bCached.cached_at ? new Date(bCached.cached_at).getTime() : 0;
        if (aTime !== bTime) {
          return direction === 'asc' ? aTime - bTime : bTime - aTime;
        }
        const aOrder = typeof a.order === 'number' ? a.order : 999999;
        const bOrder = typeof b.order === 'number' ? b.order : 999999;
        return direction === 'asc' ? aOrder - bOrder : bOrder - aOrder;
      } else {
        aVal = (a[field] || '').toLowerCase();
        bVal = (b[field] || '').toLowerCase();
        const cmp = aVal.localeCompare(bVal);
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
      }
    }
    return 0;
  });
}

function handleColumnSort(field) {
  const idx = sortStack.findIndex(s => s.field === field);
  if (idx === 0) {
    sortStack[0].direction = sortStack[0].direction === 'asc' ? 'desc' : 'asc';
  } else if (idx > 0) {
    const [item] = sortStack.splice(idx, 1);
    sortStack.unshift(item);
  } else {
    sortStack.unshift({ field, direction: 'asc' });
  }
  applyFiltersAndSort();
}

function getSortIndicator(field) {
  if (sortStack[0]?.field !== field) return '';
  return ` <span class="sort-indicator">${sortStack[0].direction === 'asc' ? '↑' : '↓'}</span>`;
}

// ---- Display Table ----

function displayConversations() {
  const tableContent = document.getElementById('tableContent');

  if (filteredConversations.length === 0) {
    const emptyMsg = currentFilterTab === 'uncached' ? 'Wszystkie czaty są już w lokalnej bazie cache!'
                   : currentFilterTab === 'cached' ? 'Brak zapisanych czatów w bazie cache.'
                   : currentFilterTab === 'failed' ? 'Brak nieudanych czatów.'
                   : 'Nie znaleziono żadnych czatów.';
    tableContent.innerHTML = `<div class="no-results">${emptyMsg}</div>`;
    document.getElementById('exportAllBtn').disabled = true;
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="order" style="width: 45px;">#${getSortIndicator('order')}</th>
          <th class="sortable" data-sort="title">Title${getSortIndicator('title')}</th>
          <th class="sortable" data-sort="section" style="width: 130px;">Data / Kolejność${getSortIndicator('section')}</th>
          <th style="width: 115px; text-align: center;">Baza lokalna</th>
          <th class="sortable" data-sort="id" style="width: 130px;">ID${getSortIndicator('id')}</th>
          <th style="width: 140px;">Actions</th>
          <th class="checkbox-col">
            <input type="checkbox" id="selectAll" ${selectedConversations.size > 0 && selectedConversations.size === filteredConversations.length ? 'checked' : ''}>
          </th>
        </tr>
      </thead>
      <tbody>
  `;

  filteredConversations.forEach((session, index) => {
    const isSelected = selectedConversations.has(session.id);
    const safeTitle = escapeHtml(session.title || 'Gemini Conversation');
    const safeId = escapeHtml(session.id);
    const chatUrl = escapeHtml(session.url || `https://gemini.google.com/app/${session.id}`);
    const orderNum = session.order !== undefined ? session.order + 1 : index + 1;

    const cachedInfo = cachedChatMap.get(session.id);
    const failedError = failedSessionsMap.get(session.id);

    html += `
      <tr data-id="${safeId}">
        <td style="color:var(--text-muted); font-size:12px; font-weight:600; text-align:center;">${orderNum}</td>
        <td>
          <div class="conv-title">
            <a href="#" class="open-chat-viewer-link" data-id="${safeId}" title="Kliknij, aby otworzyć podgląd rozmowy w przeglądarce">
              ${safeTitle}
            </a>
          </div>
        </td>
        <td class="col-time" style="color:var(--text-secondary); font-size:12px; white-space:nowrap;">
          ${formatTimeOrSection(session, cachedInfo)}
        </td>
        <td class="col-cache" style="text-align: center;">${formatCacheStatus(session, cachedInfo, failedError)}</td>
        <td class="conv-id"><code>${safeId}</code></td>
        <td class="col-actions">
          <div class="actions">${renderRowActions(session, cachedInfo, failedError)}</div>
        </td>
        <td class="checkbox-col">
          <input type="checkbox" class="conversation-checkbox" data-id="${safeId}" data-index="${index}" ${isSelected ? 'checked' : ''}>
        </td>
      </tr>
    `;
  });

  html += '</tbody></table>';
  tableContent.innerHTML = html;

  attachRowActionListeners(tableContent);

  // Checkbox interactions
  document.querySelectorAll('.conversation-checkbox').forEach(cb => {
    cb.addEventListener('click', handleCheckboxChange);
  });

  const selectAll = document.getElementById('selectAll');
  if (selectAll) selectAll.addEventListener('click', handleSelectAll);

  // Sorting columns
  document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => handleColumnSort(th.dataset.sort));
  });

  updateExportButtonText();
  document.getElementById('exportAllBtn').disabled = false;
}

// ---- Checkbox Logic ----

function handleCheckboxChange(e) {
  const id = e.target.dataset.id;
  const currentIndex = parseInt(e.target.dataset.index, 10);

  if (e.shiftKey && lastCheckedIndex !== null) {
    const start = Math.min(lastCheckedIndex, currentIndex);
    const end = Math.max(lastCheckedIndex, currentIndex);
    const checkboxes = document.querySelectorAll('.conversation-checkbox');
    for (let i = start; i <= end; i++) {
      const cb = checkboxes[i];
      if (cb) {
        cb.checked = e.target.checked;
        if (e.target.checked) {
          selectedConversations.add(cb.dataset.id);
        } else {
          selectedConversations.delete(cb.dataset.id);
        }
      }
    }
  } else {
    if (e.target.checked) {
      selectedConversations.add(id);
    } else {
      selectedConversations.delete(id);
    }
  }

  lastCheckedIndex = currentIndex;
  updateExportButtonText();
  updateSelectAllCheckbox();
}

function handleSelectAll(e) {
  document.querySelectorAll('.conversation-checkbox').forEach(cb => {
    cb.checked = e.target.checked;
    if (e.target.checked) {
      selectedConversations.add(cb.dataset.id);
    } else {
      selectedConversations.delete(cb.dataset.id);
    }
  });
  lastCheckedIndex = null;
  updateExportButtonText();
}

function updateSelectAllCheckbox() {
  const sa = document.getElementById('selectAll');
  if (sa) {
    sa.checked = selectedConversations.size > 0 && selectedConversations.size === filteredConversations.length;
  }
}

function updateExportButtonText() {
  const btn = document.getElementById('exportAllBtn');
  if (!btn) return;
  const count = selectedConversations.size > 0
    ? selectedConversations.size
    : (filteredConversations.length || allConversations.length);
  btn.textContent = count > 0 ? `⚡ Eksport (${count})` : '⚡ Eksport';
}

function updateStats() {
  const stats = document.getElementById('stats');
  if (stats) {
    const cachedCount = cachedChatMap.size;
    const isFiltered = filteredConversations.length !== allConversations.length;
    const countDisplay = isFiltered
      ? `<span title="Widoczne po przefiltrowaniu: ${filteredConversations.length} z ${allConversations.length}">${filteredConversations.length}/${allConversations.length}</span>`
      : `<span title="Wykryte czaty: ${allConversations.length}">${allConversations.length}</span>`;
    stats.innerHTML = `${countDisplay} <span style="opacity:0.35;">|</span> <span title="Czaty zapisane w lokalnej bazie cache: ${cachedCount}">💾 ${cachedCount}</span>`;
  }
}

// ---- Single Export ----

async function exportSingle(sessionId, title, button) {
  const format = document.getElementById('exportFormat')?.value || 'json';
  const includeMetadata = document.getElementById('includeMetadata')?.checked !== false;

  if (button) button.disabled = true;
  showToast(`Pobieranie czatu "${title}"...`);
  logProgress(`Rozpoczęto pojedynczy eksport czatu: "${title}" (ID: ${sessionId})`);

  const currentBrowseTab = await chrome.tabs.getCurrent().catch(() => null);

  try {
    const tab = await getOrFindGeminiTab();
    if (!tab) {
      throw new Error('Proszę otworzyć https://gemini.google.com w przeglądarce.');
    }

    // Bring Gemini tab to foreground to avoid browser background throttling
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await sendMessageWithTimeout(tab.id, {
        action: 'updateHUD',
        title: `Pobieranie: "${title}"`,
        status: 'Przygotowanie do odczytu...',
        percent: 25,
        showCancel: false
      }, 1500).catch(() => {});
    } catch (_) {}

    const targetUrl = `https://gemini.google.com/app/${sessionId}`;
    if (!tab.url || !tab.url.includes(sessionId)) {
      let spaNavigated = false;
      try {
        const spaRes = await sendMessageWithTimeout(tab.id, {
          action: 'navigateToChat',
          sessionId: sessionId
        }, 3500);
        if (spaRes && spaRes.clicked) {
          logProgress(`Szybka nawigacja SPA: "${title}"`);
          spaNavigated = true;
          await new Promise(r => setTimeout(r, 600));
        }
      } catch (_) {}

      if (!spaNavigated) {
        logProgress(`Nawigacja karty Gemini do: ${targetUrl}`);
        showToast(`Przełączanie karty Gemini na "${title}"...`);
        await navigateGeminiTab(tab.id, targetUrl);
      }
    }

    let response = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        logProgress(`Przeładowanie karty Gemini przed próbą ${attempt}...`, 'info');
        try {
          await navigateGeminiTab(tab.id, targetUrl);
        } catch (_) {}
      }
      try {
        response = await sendMessageWithTimeout(tab.id, {
          action: 'extractMessages',
          sessionId,
          title,
          chatPrefix: '📄',
          percent: 50
        }, 60000);
        if (response && response.success) break;
      } catch (err) {
        lastErr = err;
        logProgress(`Próba ${attempt}/3 ekstrakcji wiadomości: ${err.message}`, 'warn');
        await new Promise(r => setTimeout(r, 800));
      }
    }

    if (!response || !response.success) {
      throw lastErr || new Error('Nie udało się wyodrębnić wiadomości z karty Gemini.');
    }

    const messages = response.messages || [];
    const chatTitle = response.title || title || sessionId;
    const safeTitle = sanitizeFilename(chatTitle);

    const chatData = {
      conversation_id: sessionId,
      title: chatTitle,
      url: targetUrl,
      exported_at: new Date().toISOString(),
      platform: 'gemini',
      model: 'gemini-2.5-pro',
      message_count: messages.length,
      messages: messages
    };

    // Save to IndexedDB immediately so it is available locally
    try {
      if (typeof saveChatToDB === 'function') {
        await saveChatToDB(chatData);
        cachedChatMap.set(sessionId, {
          message_count: messages.length,
          cached_at: new Date().toISOString(),
          title: chatTitle
        });
        failedSessionsMap.delete(sessionId);
        updateCacheBadgeUI();
        updateTableRowUI(sessionId);
        console.log(`[Gemini Exporter DB] Zapisano czat "${safeTitle}" w lokalnej bazie IndexedDB.`);
      }
    } catch (dbErr) {
      console.warn('[Gemini Exporter DB] Błąd zapisu do IndexedDB:', dbErr);
    }

    let content, filename, mimeType;
    if (format === 'markdown') {
      content = convertToMarkdown(chatData, includeMetadata, sessionId);
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
    showToast(`✅ Pobrano (${messages.length} wiadomości): ${safeTitle}`);
    console.log(`%c[Gemini Exporter] Pomyślnie pobrano pojedynczy czat: "${safeTitle}" (${messages.length} wiadomości)`, 'color: #10b981; font-weight: bold;');

    try {
      await sendMessageWithTimeout(tab.id, {
        action: 'updateHUD',
        title: `✅ Pobrano: "${safeTitle}"`,
        status: `Zapisano ${messages.length} wiadomości.`,
        percent: 100,
        showCancel: false
      }, 1500);
      setTimeout(() => {
        sendMessageWithTimeout(tab.id, { action: 'removeHUD' }, 1000).catch(() => {});
      }, 2500);
    } catch (_) {}
  } catch (error) {
    console.error(`[Gemini Exporter] Błąd eksportu czatu ${sessionId}:`, error);
    failedSessionsMap.set(sessionId, error.message);
    updateTableRowUI(sessionId, error.message);
    showToast(`Błąd: ${error.message}`, true);
  } finally {
    if (button) button.disabled = false;
    if (currentBrowseTab && currentBrowseTab.id) {
      try {
        await chrome.tabs.update(currentBrowseTab.id, { active: true });
      } catch (_) {}
    }
  }
}

// ---- Bulk Export (ZIP) with IndexedDB Resumable Cache ----

async function exportMultiple(options = {}) {
  const customList = options?.customList || null;
  const forceRefreshIds = options?.forceRefreshIds ? new Set(options.forceRefreshIds) : new Set();
  const format = document.getElementById('exportFormat')?.value || 'json';
  const includeMetadata = document.getElementById('includeMetadata')?.checked !== false;
  const useCache = document.getElementById('useDbCache')?.checked !== false;

  const toExport = customList || (selectedConversations.size > 0
    ? filteredConversations.filter(s => selectedConversations.has(s.id))
    : filteredConversations);

  if (toExport.length === 0) {
    showToast('Nie zaznaczono żadnych rozmów do eksportu', true);
    return;
  }

  const currentBrowseTab = await chrome.tabs.getCurrent().catch(() => null);

  const exportBtn = document.getElementById('exportAllBtn');
  exportBtn.disabled = true;

  const progressModal = document.getElementById('progressModal');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const progressStats = document.getElementById('progressStats');
  const progressPercent = document.getElementById('progressPercent');
  const progressBadge = document.getElementById('progressBadge');
  const progressLog = document.getElementById('progressLog');

  progressModal.style.display = 'block';
  if (progressLog) progressLog.innerHTML = '';
  if (progressBadge) {
    progressBadge.textContent = 'W toku...';
    progressBadge.style.color = 'var(--primary-color)';
    progressBadge.style.background = 'var(--secondary-bg)';
  }

  let cancelled = false;
  const modalRetryBtn = document.getElementById('modalRetryBtn');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const cancelBtn = document.getElementById('cancelExport');
  if (modalRetryBtn) modalRetryBtn.style.display = 'none';
  if (modalCloseBtn) modalCloseBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = 'inline-block';

  isExportCancelled = false;
  cancelBtn.onclick = () => {
    cancelled = true;
    isExportCancelled = true;
    logProgress('🛑 Użytkownik zatrzymał eksport. Kończenie aktualnego czatu i generowanie archiwum ZIP...', 'warn');
    if (progressBadge) {
      progressBadge.textContent = 'Zatrzymywanie...';
      progressBadge.style.color = '#ef4444';
    }
  };

  const refreshMsg = forceRefreshIds.size > 0 ? ` (wymuszone odświeżenie ${forceRefreshIds.size} czatów)` : '';
  logProgress(`Rozpoczęto eksport ${toExport.length} czatów${refreshMsg} (format: ${format.toUpperCase()}, użycie bazy cache: ${useCache ? 'TAK' : 'NIE'})`);

  const zip = new JSZip();
  const total = toExport.length;
  let completed = 0;
  let totalMessagesExtracted = 0;
  const errors = [];

  for (let i = 0; i < total; i++) {
    if (cancelled || isExportCancelled) break;

    const session = toExport[i];
    const chatPrefix = `[${i + 1}/${total}]`;
    const pct = Math.round(((i) / total) * 100);

    progressBar.style.width = `${pct}%`;
    if (progressPercent) progressPercent.textContent = `${pct}%`;
    progressText.textContent = `${chatPrefix} ${session.title || session.id}`;
    progressStats.textContent = `Pobrano ${completed}/${total} czatów (${totalMessagesExtracted} wiadomości)`;

    // 1. Sprawdź czy czat jest już w lokalnej bazie IndexedDB (chyba że wymuszono ponowne pobranie)
    const isForceRefresh = forceRefreshIds.has(session.id);
    if (useCache && !isForceRefresh && typeof getChatFromDB === 'function') {
      try {
        const cached = await getChatFromDB(session.id);
        if (cached && cached.messages && cached.messages.length > 0) {
          const msgCount = cached.message_count || cached.messages.length;
          logProgress(`💾 ${chatPrefix} Znaleziono w bazie IndexedDB: "${session.title}" (${msgCount} wiad.). Pomijam kartę!`, 'success');

          const orderPrefix = String(session.order !== undefined ? session.order + 1 : i + 1).padStart(3, '0');
          const safeTitle = sanitizeFilename(`${orderPrefix}_${cached.title || session.title || session.id}`);

          let content, ext;
          if (format === 'markdown') {
            content = convertToMarkdown(cached, includeMetadata, session.id);
            ext = 'md';
          } else if (format === 'text') {
            content = convertToText(cached, includeMetadata);
            ext = 'txt';
          } else {
            content = convertToJson(cached);
            ext = 'json';
          }

          zip.file(`${safeTitle}.${ext}`, content);
          completed++;
          totalMessagesExtracted += msgCount;
          failedSessionsMap.delete(session.id);
          updateTableRowUI(session.id);

          progressStats.textContent = `Pobrano ${completed}/${total} czatów (${totalMessagesExtracted} wiadomości)`;
          continue; // Błyskawiczne przejście do następnego bez dotykania karty!
        }
      } catch (cacheErr) {
        console.warn(`[Gemini Exporter DB] Błąd odczytu bazy cache: ${cacheErr.message}`);
      }
    }

    if (isForceRefresh) {
      logProgress(`🔄 ${chatPrefix} Wymuszone ponowne pobranie z karty: "${session.title}" (zastąpi wersję w bazie)...`, 'warning');
    } else {
      logProgress(`${chatPrefix} Przygotowanie do pobrania: "${session.title}" (ID: ${session.id})`);
    }

    try {
      // 2. Sprawdź kartę Gemini
      const geminiTab = await getOrFindGeminiTab();
      if (!geminiTab) {
        throw new Error('Karta https://gemini.google.com została zamknięta. Otwórz ją i spróbuj ponownie.');
      }

      // CRITICAL: Bring Gemini tab to foreground.
      // In background tabs, browsers suspend IntersectionObserver & requestAnimationFrame,
      // which causes Gemini's infinite-scroller to freeze and never load messages from Google!
      try {
        await chrome.tabs.update(geminiTab.id, { active: true });
        await sendMessageWithTimeout(geminiTab.id, {
          action: 'updateHUD',
          title: `${chatPrefix} ${session.title || session.id}`,
          status: isForceRefresh ? 'Wymuszone odświeżenie...' : 'Przygotowanie do odczytu...',
          percent: pct,
          showCancel: true
        }, 1500).catch(() => {});
      } catch (_) {}

      const targetUrl = session.url || `https://gemini.google.com/app/${session.id}`;
      const currentUrl = geminiTab.url || '';

      // 3. Jeśli jesteśmy na innym czacie, spróbuj szybkiej nawigacji SPA (kliknięcie linku w pasku bocznym)
      let spaNavigated = false;
      if (!currentUrl.includes(session.id)) {
        try {
          const spaRes = await sendMessageWithTimeout(geminiTab.id, {
            action: 'navigateToChat',
            sessionId: session.id
          }, 3500);
          if (spaRes && spaRes.clicked) {
            logProgress(`${chatPrefix} Szybka nawigacja SPA: "${session.title || session.id}"`);
            spaNavigated = true;
            await new Promise(r => setTimeout(r, 600));
          }
        } catch (_) {}

        if (!spaNavigated) {
          logProgress(`${chatPrefix} Nawigacja karty Gemini do: ${targetUrl}`);
          await navigateGeminiTab(geminiTab.id, targetUrl);
        }
      } else {
        logProgress(`${chatPrefix} Karta Gemini znajduje się już pod adresem tego czatu.`);
      }

      // 4. Potwierdź gotowość skryptu content.js w karcie Gemini
      let isTabReady = false;
      for (let p = 0; p < 8; p++) {
        try {
          const pong = await sendMessageWithTimeout(geminiTab.id, { action: 'ping' }, 1200);
          if (pong && pong.pong) {
            isTabReady = true;
            break;
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 400));
      }

      // 5. Ekstrakcja wiadomości z progresywnym odczytem i elastycznym timeoutem
      logProgress(`${chatPrefix} Pobieranie i ekstrakcja treści wiadomości...`);
      let response = null;
      let extractError = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) {
          logProgress(`${chatPrefix} Twarde przeładowanie karty Gemini przed próbą ${attempt}...`, 'info');
          try {
            await navigateGeminiTab(geminiTab.id, targetUrl);
          } catch (_) {}
        }
        try {
          response = await sendMessageWithTimeout(geminiTab.id, {
            action: 'extractMessages',
            sessionId: session.id,
            title: session.title,
            chatPrefix: chatPrefix,
            percent: pct
          }, 60000);
          if (response && response.success && response.messages && response.messages.length > 0) {
            break;
          } else if (response && response.success && (!response.messages || response.messages.length === 0)) {
            throw new Error('Karta zwróciła pustą listę wiadomości (0 wiadomości w DOM).');
          }
        } catch (err) {
          extractError = err;
          // Jeśli czat został usunięty lub przekierowany do pustego /app - nie marnuj kolejnych prób!
          if (err.message.includes('Czat nie istnieje') || err.message.includes('przekierowany') || err.message.includes('pustej strony') || err.message.includes('usunięty')) {
            logProgress(`⚠️ ${chatPrefix} Czat pusty lub usunięty: ${err.message}`, 'warn');
            break;
          }
          logProgress(`${chatPrefix} Próba ${attempt}/3 ekstrakcji: ${err.message}. Ponawianie za ${attempt * 1.5}s...`, 'warn');
          await new Promise(r => setTimeout(r, attempt * 1500));
        }
      }

      if (!response || !response.success || !response.messages || response.messages.length === 0) {
        throw extractError || new Error('Nie udało się wyodrębnić wiadomości (wykryto 0 wiadomości w oknie).');
      }

      const messages = response.messages;
      const msgCount = response.count !== undefined ? response.count : messages.length;
      totalMessagesExtracted += msgCount;

      logProgress(`✅ ${chatPrefix} Sukces: pobrano ${msgCount} wiadomości dla "${session.title}"`, 'success');

      const nextPct = Math.round(((i + 1) / total) * 100);
      try {
        await sendMessageWithTimeout(geminiTab.id, {
          action: 'updateHUD',
          title: `${chatPrefix} ${session.title || session.id}`,
          status: `✅ Pobrano ${msgCount} wiadomości`,
          percent: nextPct,
          showCancel: true
        }, 1500).catch(() => {});
      } catch (_) {}

      // 5. Przygotuj strukturę danych
      const chatData = {
        conversation_id: session.id,
        title: response.title || session.title,
        url: targetUrl,
        exported_at: new Date().toISOString(),
        platform: 'gemini',
        model: 'gemini-2.5-pro',
        message_count: msgCount,
        messages: messages
      };

      // 6. Zapisz natychmiast do lokalnej bazy IndexedDB!
      try {
        if (typeof saveChatToDB === 'function') {
          await saveChatToDB(chatData);
          cachedChatMap.set(session.id, {
            message_count: msgCount,
            cached_at: new Date().toISOString(),
            title: chatData.title
          });
          failedSessionsMap.delete(session.id);
          updateCacheBadgeUI();
          updateTableRowUI(session.id);
          logProgress(`💾 ${chatPrefix} Czat trwale zapisany w lokalnej bazie IndexedDB`);
        }
      } catch (dbErr) {
        console.warn('[Gemini Exporter DB] Błąd zapisu do IndexedDB:', dbErr);
      }

      const orderPrefix = String(session.order !== undefined ? session.order + 1 : i + 1).padStart(3, '0');
      const safeTitle = sanitizeFilename(`${orderPrefix}_${session.title || session.id}`);

      let content, ext;
      if (format === 'markdown') {
        content = convertToMarkdown(chatData, includeMetadata, session.id);
        ext = 'md';
      } else if (format === 'text') {
        content = convertToText(chatData, includeMetadata);
        ext = 'txt';
      } else {
        content = convertToJson(chatData);
        ext = 'json';
      }

      zip.file(`${safeTitle}.${ext}`, content);
      completed++;

      progressStats.textContent = `Pobrano ${completed}/${total} czatów (${totalMessagesExtracted} wiadomości)`;

    } catch (err) {
      console.error(`[Gemini Exporter] Błąd eksportu czatu ${session.id}:`, err);
      logProgress(`❌ ${chatPrefix} Błąd: ${err.message}`, 'error');
      errors.push(`${session.title || session.id}: ${err.message}`);
      failedSessionsMap.set(session.id, err.message);
      updateTableRowUI(session.id, err.message);
    }

    const currentPct = Math.round(((i + 1) / total) * 100);
    progressBar.style.width = `${currentPct}%`;
    if (progressPercent) progressPercent.textContent = `${currentPct}%`;

    // Krótka pauza między czatami
    await new Promise(r => setTimeout(r, 350));
  }

  progressBar.style.width = '100%';
  if (progressPercent) progressPercent.textContent = '100%';
  progressText.textContent = 'Kompresowanie i generowanie pliku ZIP...';
  logProgress(`Generowanie archiwum ZIP dla ${completed} pomyślnie pobranych czatów...`);

  try {
    const endTab = await getOrFindGeminiTab();
    if (endTab) {
      await sendMessageWithTimeout(endTab.id, {
        action: 'updateHUD',
        title: 'Kompresowanie i generowanie pliku ZIP...',
        status: `Pakowanie ${completed} czatów (${totalMessagesExtracted} wiadomości)...`,
        percent: 98,
        showCancel: false
      }, 1500).catch(() => {});
    }
  } catch (_) {}

  const timestamp = getTimestamp();
  const zipFilename = `gemini-all-chats-${timestamp}.zip`;

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  const blobUrl = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = zipFilename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }, 30000);

  logProgress(`🎉 Archiwum ZIP pobrane: ${zipFilename}`, 'success');

  try {
    const endTab = await getOrFindGeminiTab();
    if (endTab) {
      await sendMessageWithTimeout(endTab.id, {
        action: 'updateHUD',
        title: '🎉 Eksport zakończony sukcesem!',
        status: `Zapisano ${completed}/${total} czatów (${totalMessagesExtracted} wiadomości) do ZIP`,
        percent: 100,
        showCancel: false
      }, 1500).catch(() => {});
      setTimeout(() => {
        sendMessageWithTimeout(endTab.id, { action: 'removeHUD' }, 1000).catch(() => {});
      }, 3500);
    }
  } catch (_) {}

  if (progressBadge) {
    if (cancelled) {
      progressBadge.textContent = 'Zatrzymano';
      progressBadge.style.color = '#f59e0b';
    } else if (errors.length > 0) {
      progressBadge.textContent = `${errors.length} błędów`;
      progressBadge.style.color = '#ef4444';
      progressBadge.style.background = 'rgba(239,68,68,0.15)';
    } else {
      progressBadge.textContent = 'Zakończono';
      progressBadge.style.color = '#10b981';
    }
  }

  // Zaktualizuj widok tabeli aby pokazać nowe etykiety bazy danych
  await refreshCachedMap();
  applyFiltersAndSort();

  if (errors.length > 0 && !cancelled) {
    if (modalRetryBtn) {
      const modalRetryCount = document.getElementById('modalRetryCount');
      if (modalRetryCount) modalRetryCount.textContent = errors.length;
      modalRetryBtn.style.display = 'inline-block';
    }
    if (modalCloseBtn) modalCloseBtn.style.display = 'inline-block';
    if (cancelBtn) cancelBtn.style.display = 'none';
    exportBtn.disabled = false;
  } else {
    setTimeout(() => {
      progressModal.style.display = 'none';
      exportBtn.disabled = false;
    }, 2500);
  }

  if (cancelled) {
    showToast(`Eksport zatrzymany. Zapisano ${completed} czatów (${totalMessagesExtracted} wiadomości) do ZIP.`, true);
  } else if (errors.length > 0) {
    showToast(`Pobrano ${completed}/${total} czatów (${totalMessagesExtracted} wiadomości). ${errors.length} błędów.`, true);
  } else {
    showToast(`🎉 Pomyślnie wyeksportowano wszystkie ${completed} czatów (${totalMessagesExtracted} wiadomości) do ${zipFilename}!`);
  }

  // Restore focus to browse dashboard so user sees results immediately
  if (currentBrowseTab && currentBrowseTab.id) {
    try {
      await chrome.tabs.update(currentBrowseTab.id, { active: true });
    } catch (_) {}
  }
}

// ---- Instant Export All Cached Chats Directly from IndexedDB ----

async function exportAllFromDB() {
  const format = document.getElementById('exportFormat')?.value || 'json';
  const includeMetadata = document.getElementById('includeMetadata')?.checked !== false;

  const btn = document.getElementById('exportCachedBtn');
  if (btn) btn.disabled = true;

  showToast('Przygotowywanie eksportu z lokalnej bazy IndexedDB...');

  try {
    if (typeof getAllChatsFromDB !== 'function') {
      throw new Error('Moduł bazy danych nie jest dostępny.');
    }

    const chats = await getAllChatsFromDB();
    if (!chats || chats.length === 0) {
      showToast('Brak zapisanych czatów w lokalnej bazie IndexedDB.', true);
      return;
    }

    const progressModal = document.getElementById('progressModal');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const progressStats = document.getElementById('progressStats');
    const progressPercent = document.getElementById('progressPercent');
    const progressBadge = document.getElementById('progressBadge');
    const progressLog = document.getElementById('progressLog');

    progressModal.style.display = 'block';
    if (progressLog) progressLog.innerHTML = '';
    if (progressBadge) {
      progressBadge.textContent = 'Baza DB';
      progressBadge.style.color = '#10b981';
      progressBadge.style.background = 'rgba(16,185,129,0.12)';
    }

    logProgress(`⚡ Rozpoczęto błyskawiczny eksport ${chats.length} czatów bezpośrednio z lokalnej bazy IndexedDB...`);

    const zip = new JSZip();
    let totalMsgs = 0;

    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i];
      const msgCount = chat.message_count || (chat.messages ? chat.messages.length : 0);
      totalMsgs += msgCount;

      const orderPrefix = String(i + 1).padStart(3, '0');
      const safeTitle = sanitizeFilename(`${orderPrefix}_${chat.title || chat.id}`);

      let content, ext;
      if (format === 'markdown') {
        content = convertToMarkdown(chat, includeMetadata, chat.id);
        ext = 'md';
      } else if (format === 'text') {
        content = convertToText(chat, includeMetadata);
        ext = 'txt';
      } else {
        content = convertToJson(chat);
        ext = 'json';
      }

      zip.file(`${safeTitle}.${ext}`, content);

      const pct = Math.round(((i + 1) / chats.length) * 100);
      progressBar.style.width = `${pct}%`;
      if (progressPercent) progressPercent.textContent = `${pct}%`;
      progressText.textContent = `Pakowanie: [${i + 1}/${chats.length}] ${chat.title || chat.id}`;
      progressStats.textContent = `Spakowano ${i + 1}/${chats.length} czatów (${totalMsgs} wiadomości)`;
    }

    progressText.textContent = 'Generowanie pliku ZIP...';
    logProgress(`Generowanie archiwum ZIP dla ${chats.length} czatów z bazy...`);

    const timestamp = getTimestamp();
    const zipFilename = `gemini-cached-chats-${timestamp}.zip`;

    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    const blobUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = zipFilename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    }, 30000);

    logProgress(`🎉 Pomyślnie wyeksportowano ${chats.length} czatów z bazy do ${zipFilename}!`, 'success');

    setTimeout(() => {
      progressModal.style.display = 'none';
      if (btn) btn.disabled = false;
    }, 2500);

    showToast(`🎉 Wyeksportowano ${chats.length} czatów (${totalMsgs} wiadomości) z bazy do ${zipFilename}!`);

  } catch (err) {
    console.error('[Gemini Exporter DB] Błąd eksportu z bazy:', err);
    showToast(`Błąd eksportu z bazy: ${err.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- Toast and Error Helpers ----

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.background = isError ? 'var(--error-color)' : 'var(--toast-bg)';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

function showError(message) {
  const tableContent = document.getElementById('tableContent');
  if (tableContent) {
    tableContent.innerHTML = `<div class="error-msg">⚠️ ${escapeHtml(message)}</div>`;
  }
  const stats = document.getElementById('stats');
  if (stats) stats.innerHTML = '<span style="color:var(--error-color);">Błąd</span>';
}

// ---- Filter Toolbar Handling ----

function setupFilterTabs() {
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilterTab = tab.dataset.tab;
      applyFiltersAndSort();
    });
  });

  const syncMissingBtn = document.getElementById('syncMissingBtn');
  if (syncMissingBtn) {
    syncMissingBtn.addEventListener('click', () => {
      const missing = allConversations.filter(s => !cachedChatMap.has(s.id));
      if (missing.length === 0) {
        showToast('🎉 Wszystkie czaty są już w lokalnej bazie!');
        return;
      }
      selectedConversations.clear();
      missing.forEach(s => selectedConversations.add(s.id));
      currentFilterTab = 'uncached';
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'uncached'));
      applyFiltersAndSort();
      showToast(`⚡ Rozpoczynanie pobierania ${missing.length} brakujących czatów...`);
      exportMultiple();
    });
  }

  const retryFailedBtn = document.getElementById('retryFailedBtn');
  if (retryFailedBtn) {
    retryFailedBtn.addEventListener('click', () => {
      if (failedSessionsMap.size === 0) {
        showToast('Brak błędów do ponowienia.');
        return;
      }
      const failed = allConversations.filter(s => failedSessionsMap.has(s.id));
      selectedConversations.clear();
      failed.forEach(s => selectedConversations.add(s.id));
      currentFilterTab = 'failed';
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'failed'));
      applyFiltersAndSort();
      showToast(`🔁 Ponawianie ${failed.length} nieudanych czatów...`);
      exportMultiple();
    });
  }

  const modalRetryBtn = document.getElementById('modalRetryBtn');
  if (modalRetryBtn) {
    modalRetryBtn.addEventListener('click', () => {
      const progressModal = document.getElementById('progressModal');
      if (progressModal) progressModal.style.display = 'none';
      const rBtn = document.getElementById('retryFailedBtn');
      if (rBtn) rBtn.click();
    });
  }

  const modalCloseBtn = document.getElementById('modalCloseBtn');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => {
      const progressModal = document.getElementById('progressModal');
      if (progressModal) progressModal.style.display = 'none';
      const exportBtn = document.getElementById('exportAllBtn');
      if (exportBtn) exportBtn.disabled = false;
    });
  }
}

// ---- Checkbox Dependencies ----

function setupOptionDependencies() {
  const formatSelect = document.getElementById('exportFormat');
  const includeChats = document.getElementById('includeChats');
  const includeMetadata = document.getElementById('includeMetadata');

  function update() {
    const isJson = formatSelect.value === 'json';
    if (includeChats) includeChats.disabled = isJson;
    if (includeMetadata) includeMetadata.disabled = isJson;

    if (isJson) {
      if (includeChats) includeChats.checked = true;
      if (includeMetadata) includeMetadata.checked = true;
    }
  }

  if (formatSelect) formatSelect.addEventListener('change', update);
  update();
}

// ---- Init ----

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  setupFilterTabs();
  setupOptionDependencies();

  const manifest = chrome.runtime.getManifest();
  const versionElem = document.getElementById('header-version');
  if (versionElem) versionElem.textContent = 'v' + manifest.version;

  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

  const searchInput = document.getElementById('searchInput');
  const searchBox = document.getElementById('searchBox');
  if (searchInput && searchBox) {
    searchInput.addEventListener('input', () => {
      searchBox.classList.toggle('has-text', !!searchInput.value);
      applyFiltersAndSort();
    });

    const clearSearch = document.getElementById('clearSearch');
    if (clearSearch) {
      clearSearch.addEventListener('click', () => {
        searchInput.value = '';
        searchBox.classList.remove('has-text');
        applyFiltersAndSort();
      });
    }
  }

  const exportAllBtn = document.getElementById('exportAllBtn');
  if (exportAllBtn) exportAllBtn.addEventListener('click', exportMultiple);

  const exportCachedBtn = document.getElementById('exportCachedBtn');
  if (exportCachedBtn) exportCachedBtn.addEventListener('click', exportAllFromDB);

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadConversations(true));

  const stopScanBtn = document.getElementById('stopScanBtn');
  if (stopScanBtn) {
    stopScanBtn.addEventListener('click', async () => {
      try {
        logProgress('Wysyłanie sygnału zatrzymania skanowania do karty Gemini...');
        await sendMessageToGeminiTab('stopScan', {}, 3000);
        showScanBanner('🛑 Skanowanie zatrzymane przez użytkownika', `${allConversations.length} czatów zachowano`, 100);
        hideScanBanner(2500);
      } catch (err) {
        console.warn('[Gemini Exporter] Błąd wysyłania stopScan:', err);
      }
    });
  }

  const copyLogsBtn = document.getElementById('copyLogsBtn');
  if (copyLogsBtn) {
    copyLogsBtn.addEventListener('click', async () => {
      try {
        let text = diagnosticLogBuffer.join('\n');
        try {
          const res = await fetch('http://localhost:3040/logs');
          if (res.ok) {
            const data = await res.json();
            text = data.map(e => `[${e.time}] [${e.source.toUpperCase()}] [${e.level}] ${e.message} ${e.details ? JSON.stringify(e.details) : ''}`).join('\n');
          }
        } catch (_) {}

        if (!text) text = 'Brak zarejestrowanych logów diagnostycznych.';
        await navigator.clipboard.writeText(text);
        showToast('📋 Logi diagnostyczne skopiowane do schowka!');
      } catch (err) {
        showToast(`Błąd kopiowania: ${err.message}`, true);
      }
    });
  }

  // Local Chat Viewer Modal Bindings
  const viewerModal = document.getElementById('chatViewerModal');
  const viewerCloseBtn = document.getElementById('viewerCloseBtn');
  const viewerCopyMdBtn = document.getElementById('viewerCopyMdBtn');
  const viewerExportJsonBtn = document.getElementById('viewerExportJsonBtn');

  if (viewerCloseBtn) {
    viewerCloseBtn.onclick = () => { if (viewerModal) viewerModal.style.display = 'none'; };
  }
  if (viewerModal) {
    viewerModal.onclick = (e) => {
      if (e.target === viewerModal) viewerModal.style.display = 'none';
    };
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && viewerModal && viewerModal.style.display !== 'none') {
      viewerModal.style.display = 'none';
    }
  });

  if (viewerCopyMdBtn) {
    viewerCopyMdBtn.onclick = () => {
      if (!currentViewerChat || !currentViewerChat.messages) return;
      const md = convertToMarkdown(currentViewerChat, true, currentViewerChat.conversation_id);
      navigator.clipboard.writeText(md);
      showToast('📋 Skopiowano całą rozmowę jako Markdown do schowka!');
    };
  }

  if (viewerExportJsonBtn) {
    viewerExportJsonBtn.onclick = () => {
      if (!currentViewerChat) return;
      const json = convertToJson(currentViewerChat);
      const safe = sanitizeFilename(currentViewerChat.title || 'chat');
      downloadFile(json, `${safe}.json`, 'application/json');
    };
  }

  const viewerRefreshFromGeminiBtn = document.getElementById('viewerRefreshFromGeminiBtn');
  if (viewerRefreshFromGeminiBtn) {
    viewerRefreshFromGeminiBtn.onclick = async () => {
      if (!currentViewerChat || !currentViewerChat.conversation_id) return;
      const sid = currentViewerChat.conversation_id;
      const title = currentViewerChat.title || 'chat';
      viewerRefreshFromGeminiBtn.disabled = true;
      viewerRefreshFromGeminiBtn.textContent = 'Pobieranie...';
      showToast(`🔄 Pobieranie pełnej historii dla "${title}"...`);
      try {
        await exportSingle(sid, title, viewerRefreshFromGeminiBtn);
        await openChatViewer(sid);
      } finally {
        viewerRefreshFromGeminiBtn.disabled = false;
        viewerRefreshFromGeminiBtn.textContent = '🔄 Odśwież z Gemini';
      }
    };
  }

  loadConversations();
});
