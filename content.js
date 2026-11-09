// Content script for Gemini Chat Exporter with Bulk History Scraping & ZIP packaging
// Runs on gemini.google.com

if (window.geminiChatExporterLoaded) {
  console.log('Gemini Chat Exporter: Content script already loaded, skipping re-injection');
} else {
  window.geminiChatExporterLoaded = true;

  console.log('Gemini Chat Exporter: Content script initialized');

  const EXTENSION_VERSION = 'v1.3.0';
  let isBulkExportRunning = false;
  let cancelExportRequested = false;

  function sendDiagnosticLog(level, message, details = null) {
    const style = level === 'error' ? 'color: #ef4444; font-weight: bold;'
                : level === 'warn' ? 'color: #f59e0b; font-weight: bold;'
                : level === 'success' ? 'color: #10b981; font-weight: bold;'
                : 'color: #3b82f6;';
    console.log(`%c[Gemini Content] [${EXTENSION_VERSION}] ${message}`, style, details || '');

    // Send to extension runtime to forward to diagnostic server (bypasses page CSP)
    try {
      chrome.runtime.sendMessage({
        action: 'diagnosticLog',
        source: 'content',
        version: EXTENSION_VERSION,
        level,
        message: `[${EXTENSION_VERSION}] ${message}`,
        details
      }).catch(() => {});
    } catch (_) {}
  }

  // Sanitize filename to avoid OS invalid characters
  function sanitizeFilename(name) {
    if (!name) return 'untitled_chat';
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

  // Check if an element is inside any sidebar / navigation drawer
  function isInsideSidebar(el) {
    if (!el || !el.closest) return false;
    // Elements inside main chat area are NEVER in sidebar!
    if (el.closest('main, [role="main"], chat-window, [class*="chat-window"], [class*="conversation-container"]')) {
      return false;
    }
    return !!el.closest('aside, nav, [role="navigation"], [class*="side-nav"], [class*="side-bar"], [data-test-id="navigation-history"], bard-sidenav, mat-sidenav');
  }

  // Fast O(N*depth) deduplication: remove any element that has an ancestor already in the set
  function removeNestedElements(elements) {
    if (elements.length <= 1) return elements;
    const elSet = new Set(elements);
    const result = [];
    for (const el of elements) {
      let cur = el.parentElement;
      let hasAncestor = false;
      while (cur && cur !== document.body) {
        if (elSet.has(cur)) {
          hasAncestor = true;
          break;
        }
        cur = cur.parentElement;
      }
      if (!hasAncestor) {
        result.push(el);
      }
    }
    return result;
  }

  // Find the main chat container
  function getChatMainContainer() {
    const candidates = [
      'chat-window',
      '[role="main"]',
      'main',
      '.chat-history',
      '#chat-history',
      '[class*="conversation-container"]'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  }

  // Find the first chat message element outside sidebar
  function findFirstChatMessageElement() {
    const msgs = document.querySelectorAll('user-query, model-response, chat-turn, [data-test-id="user-query"], [data-test-id="model-response"], .query-content, [class*="query-text"], message-content, markdown-renderer');
    for (const el of msgs) {
      if (!isInsideSidebar(el)) {
        return el;
      }
    }
    return null;
  }

  // Diagnostic summary of current DOM state for telemetry logging
  function getDomDiagnosticSummary(root) {
    try {
      const r = root || document;
      const mainEl = document.querySelector('chat-window, [role="main"], main');
      const uq = r.querySelectorAll('user-query').length;
      const qc = r.querySelectorAll('.query-content').length;
      const mr = r.querySelectorAll('model-response').length;
      const mc = r.querySelectorAll('message-content').length;
      const mdr = r.querySelectorAll('markdown-renderer').length;
      const ct = r.querySelectorAll('chat-turn').length;

      const globUq = document.querySelectorAll('user-query').length;
      const globQc = document.querySelectorAll('.query-content').length;
      const globMc = document.querySelectorAll('message-content').length;
      const globCt = document.querySelectorAll('chat-turn').length;

      const mainTag = mainEl ? mainEl.tagName.toLowerCase() : 'brak';
      return `main=<${mainTag}> uq=${uq}(${globUq}) qc=${qc}(${globQc}) mc=${mc}(${globMc}) ct=${ct}(${globCt})`;
    } catch (_) {
      return 'diag_err';
    }
  }

  // Comprehensive DOM inspector to analyze Gemini page structure
  function dumpMainDomStructure(context = 'wait') {
    try {
      const main = document.querySelector('chat-window, [role="main"], main') || document.body;
      const allElements = Array.from(document.querySelectorAll('*'));

      // All custom elements on the page (tags with hyphens)
      const customElements = Array.from(new Set(
        allElements.map(el => el.tagName.toLowerCase()).filter(t => t.includes('-'))
      ));

      // Global selector counts across the whole document
      const selectorCounts = {
        'user-query': document.querySelectorAll('user-query').length,
        '.query-content': document.querySelectorAll('.query-content').length,
        '[class*="query-text"]': document.querySelectorAll('[class*="query-text"]').length,
        'model-response': document.querySelectorAll('model-response').length,
        'message-content': document.querySelectorAll('message-content').length,
        'markdown-renderer': document.querySelectorAll('markdown-renderer').length,
        'chat-turn': document.querySelectorAll('chat-turn').length,
        '[class*="chat-turn"]': document.querySelectorAll('[class*="chat-turn"]').length,
        '[class*="conversation"]': document.querySelectorAll('[class*="conversation"]').length,
        'p': document.querySelectorAll('p').length,
        'aside': document.querySelectorAll('aside').length,
        'nav': document.querySelectorAll('nav').length,
        'infinite-scroller': document.querySelectorAll('infinite-scroller').length,
      };

      // Top level tags of main
      const mainChildrenInfo = main ? Array.from(main.children).slice(0, 8).map(c => {
        const cls = c.className && typeof c.className === 'string' ? '.' + c.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return `<${c.tagName.toLowerCase()}${cls}>`;
      }).join(' ') : 'none';

      // HTML snippet of main (first 1500 characters of clean outerHTML)
      let snippet = '';
      if (main) {
        snippet = (main.outerHTML || '')
          .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg>...</svg>')
          .slice(0, 1500);
      }

      // Sample visible text snippet (first 300 chars)
      const visibleText = (document.body.innerText || '').slice(0, 300).replace(/\s+/g, ' ');

      const dump = {
        context,
        url: window.location.href,
        pathname: window.location.pathname,
        mainTag: main ? main.tagName.toLowerCase() : 'brak',
        mainChildren: mainChildrenInfo,
        selectorCounts,
        customElements: customElements.slice(0, 30),
        visibleTextSnippet: visibleText,
        htmlSnippet: snippet
      };

      sendDiagnosticLog('info', `[DOM DUMP - ${context}] main=<${dump.mainTag}> | selektory=${JSON.stringify(selectorCounts)} | tekst="${visibleText.slice(0, 80)}..."`, dump);
      return dump;
    } catch (e) {
      sendDiagnosticLog('warn', `[DOM DUMP ERR] ${e.message}`);
      return null;
    }
  }

  // Find chat scrolling element (ensuring it is an ancestor of messages, NEVER sidebar)
  function findChatScrollElement() {
    const firstMsg = findFirstChatMessageElement();
    if (firstMsg) {
      let cur = firstMsg.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        if (isInsideSidebar(cur)) break;
        const style = window.getComputedStyle(cur);
        const ovY = style.overflowY || '';
        if (['auto', 'scroll', 'overlay'].includes(ovY) && cur.scrollHeight > cur.clientHeight + 10) {
          return cur;
        }
        cur = cur.parentElement;
      }

      // Check any ancestor with scrollHeight > clientHeight + 40
      cur = firstMsg.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        if (!isInsideSidebar(cur) && cur.scrollHeight > cur.clientHeight + 40) {
          return cur;
        }
        cur = cur.parentElement;
      }
    }

    // Fallback: look inside main container
    const main = getChatMainContainer();
    if (main && main !== document.body) {
      if (main.scrollHeight > main.clientHeight + 40) return main;
      const candidates = main.querySelectorAll('*');
      for (const el of candidates) {
        if (isInsideSidebar(el)) continue;
        const s = window.getComputedStyle(el);
        if (['auto', 'scroll', 'overlay'].includes(s.overflowY) && el.scrollHeight > el.clientHeight + 40) {
          return el;
        }
      }
    }

    return document.scrollingElement || document.documentElement || document.body;
  }

  // Get ordered user prompts and model responses strictly from main chat
  function getChatTurnElements(container) {
    const root = container || document;

    const USER_SELECTORS = [
      'user-query',
      '[data-test-id="user-query"]',
      '.user-query',
      '[class*="user-query"]',
      '.query-content',
      '[class*="query-text"]',
      'chat-turn [class*="user"]'
    ].join(', ');

    const MODEL_SELECTORS = [
      'model-response',
      '[data-test-id="model-response"]',
      '.model-response',
      '[class*="model-response"]',
      'message-content',
      'markdown-renderer',
      '[class*="response-container"]',
      'chat-turn [class*="model"]'
    ].join(', ');

    let userEls = Array.from(root.querySelectorAll(USER_SELECTORS))
      .filter(el => !isInsideSidebar(el));
    let modelEls = Array.from(root.querySelectorAll(MODEL_SELECTORS))
      .filter(el => !isInsideSidebar(el));

    // Fast O(N*depth) deduplication: drops nested children when parent turn element is selected
    userEls = removeNestedElements(userEls);
    modelEls = removeNestedElements(modelEls);

    const turns = [];
    userEls.forEach(el => turns.push({ element: el, role: 'user' }));
    modelEls.forEach(el => turns.push({ element: el, role: 'assistant' }));

    // Sort by natural document tree order
    turns.sort((a, b) => {
      if (a.element === b.element) return 0;
      const pos = a.element.compareDocumentPosition(b.element);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return turns;
  }

  // Extract currently visible user queries and model responses from the DOM
  function extractCurrentVisibleMessages() {
    const messages = [];

    try {
      const turns = getChatTurnElements();

      turns.forEach(item => {
        try {
          const content = extractContentFromElement(item.element);
          if (content && content.trim()) {
            const key = item.role + ':::' + content.trim().slice(0, 150).replace(/\s+/g, ' ');
            messages.push({
              role: item.role,
              content: content.trim(),
              key: key,
              order: getElementPosition(item.element)
            });
          }
        } catch (_) {}
      });
    } catch (e) {
      console.error('[Gemini Exporter Content] Błąd odczytu widocznych wiadomości:', e);
    }

    return messages;
  }

  // Synchronous extractor for currently active Gemini chat
  function extractChatMessages() {
    const raw = extractCurrentVisibleMessages();
    const seenContent = new Set();
    const messages = [];

    raw.forEach((item) => {
      const normalizedContent = item.content.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!seenContent.has(normalizedContent)) {
        seenContent.add(normalizedContent);
        messages.push({
          role: item.role,
          content: item.content,
          timestamp: new Date().toISOString(),
          index: messages.length
        });
      }
    });

    if (messages.length === 0) {
      extractMessagesAlternative(messages);
    }
    return messages;
  }

  // Merge newly visible batch into master message list preserving chronological order
  function mergeMessages(masterList, newBatch) {
    if (!masterList || masterList.length === 0) {
      return (newBatch || []).slice();
    }
    if (!newBatch || newBatch.length === 0) {
      return masterList;
    }

    const masterKeys = masterList.map(m => m.key);

    // 1. Check for older messages to prepend (scrolled UP)
    for (let i = 0; i < newBatch.length; i++) {
      const k = newBatch[i].key;
      const matchPos = masterKeys.indexOf(k);
      if (matchPos !== -1) {
        const itemsToPrepend = [];
        for (let j = 0; j < i; j++) {
          if (!masterKeys.includes(newBatch[j].key)) {
            itemsToPrepend.push(newBatch[j]);
          }
        }
        if (itemsToPrepend.length > 0) {
          masterList.unshift(...itemsToPrepend);
        }
        break;
      }
    }

    // 2. Check for newer messages to append (scrolled DOWN)
    const updatedMasterKeys = new Set(masterList.map(m => m.key));
    for (const item of newBatch) {
      if (!updatedMasterKeys.has(item.key)) {
        masterList.push(item);
        updatedMasterKeys.add(item.key);
      }
    }

    return masterList;
  }

  // Progressive extractor with auto-scroll and dynamic watchdog
  async function progressiveExtractChatMessages(sessionId, onProgressUpdate) {
    const startTime = Date.now();
    const maxWaitMs = 22000;

    // 1. Wait for Google server to deliver the chat (with fast abort for 404/redirect/error)
    let lastLogTime = Date.now();
    let initialTurns = [];
    let dumpedAt3s = false;
    let dumpedAt10s = false;

    while (Date.now() - startTime < maxWaitMs) {
      // Check for quick redirect to empty /app
      if (sessionId) {
        const curPath = window.location.pathname;
        if (Date.now() - startTime > 1500 && (curPath === '/app' || curPath === '/app/')) {
          sendDiagnosticLog('warn', `Karta przekierowała do pustej strony /app zamiast /app/${sessionId}`);
          throw new Error('Czat nie istnieje lub został przekierowany do nowej pustej rozmowy.');
        }
      }

      // Check for Google error card
      const errorCard = document.querySelector('[data-test-id="error-message"], .error-card, .error-container');
      if (errorCard && errorCard.textContent.trim()) {
        const errText = errorCard.textContent.trim();
        sendDiagnosticLog('warn', `Wykryto błąd na stronie Gemini: ${errText}`);
        throw new Error(`Błąd strony Gemini: ${errText}`);
      }

      initialTurns = getChatTurnElements();
      if (initialTurns.length > 0) {
        break;
      }

      const elapsedMs = Date.now() - startTime;
      if (!dumpedAt3s && elapsedMs >= 3000) {
        dumpedAt3s = true;
        dumpMainDomStructure('3s-probe');
      }
      if (!dumpedAt10s && elapsedMs >= 10000) {
        dumpedAt10s = true;
        dumpMainDomStructure('10s-probe');
      }

      // Live progress notification every 2 seconds with rich DOM telemetry
      if (Date.now() - lastLogTime >= 2000) {
        lastLogTime = Date.now();
        const elapsedSec = Math.round(elapsedMs / 1000);
        const domSummary = getDomDiagnosticSummary(getChatMainContainer());
        const msg = `Oczekiwanie na odpowiedź serwera Google (${elapsedSec}s)... [${domSummary}]`;
        sendDiagnosticLog('info', `[${sessionId || 'aktywny'}] ${msg}`);
        if (typeof onProgressUpdate === 'function') onProgressUpdate(0, msg);
        chrome.runtime.sendMessage({
          action: 'extractProgress',
          sessionId,
          count: 0,
          status: msg
        }).catch(() => {});

        // Anti-throttling stimulus: nudge browser layout and fire virtual scroller events
        try {
          window.dispatchEvent(new Event('focus'));
          window.dispatchEvent(new Event('resize'));
          const chatScrollers = document.querySelectorAll('chat-window infinite-scroller, main infinite-scroller');
          chatScrollers.forEach(s => s.dispatchEvent(new Event('scroll', { bubbles: true })));
        } catch (_) {}
      }

      await new Promise(r => setTimeout(r, 200));
    }

    if (initialTurns.length === 0) {
      dumpMainDomStructure('timeout-fail');
      throw new Error(`Nie wykryto żadnych wiadomości po ${Math.round((Date.now() - startTime) / 1000)}s oczekiwania na serwer Google.`);
    }

    const elapsedTotal = Date.now() - startTime;
    const userCount = initialTurns.filter(t => t.role === 'user').length;
    const assistantCount = initialTurns.filter(t => t.role === 'assistant').length;
    sendDiagnosticLog('info', `DOM gotowy: wykryto ${initialTurns.length} tur (${userCount} pytań, ${assistantCount} odpowiedzi) po ${elapsedTotal}ms. Rozpoczęto odczyt...`);
    await new Promise(r => setTimeout(r, 300));

    // 2. Identify scroll container
    const scroller = findChatScrollElement();
    const scrollerTag = scroller ? scroller.tagName.toLowerCase() : 'none';
    const scrollerClass = scroller && scroller.className ? String(scroller.className).slice(0, 35) : '';
    const scrollHeight = scroller ? scroller.scrollHeight : 0;
    const clientHeight = scroller ? scroller.clientHeight : 0;
    const ovY = scroller ? window.getComputedStyle(scroller).overflowY : '';
    sendDiagnosticLog('info', `Scroller: <${scrollerTag} class="${scrollerClass}"> (scrollHeight=${scrollHeight}px, clientHeight=${clientHeight}px, overflowY=${ovY})`);

    // 3. Initial harvest
    let masterMessages = [];
    masterMessages = mergeMessages(masterMessages, extractCurrentVisibleMessages());
    sendDiagnosticLog('info', `Początkowy odczyt DOM: ${masterMessages.length} wiadomości`);

    const isScrollable = scroller && (scroller.scrollHeight > scroller.clientHeight + 25);

    if (isScrollable) {
      // Phase 1: Scroll UP to load older messages from Google server
      sendDiagnosticLog('info', `Faza 1: Sprawdzanie wcześniejszych wiadomości (scroll w górę, scrollHeight=${scroller.scrollHeight}px)...`);
      let upAttempts = 0;
      let lastScrollHeight = scroller.scrollHeight;
      let consecutiveStagnantUp = 0;

      while (upAttempts < 80 && consecutiveStagnantUp < 4) {
        upAttempts++;
        const currentScrollTop = scroller.scrollTop;

        // Scroll up
        scroller.scrollTop = Math.max(0, currentScrollTop - Math.floor(scroller.clientHeight * 0.85));
        if (upAttempts % 3 === 0) {
          scroller.scrollTop = 0; // Trigger top boundary listeners
        }
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise(r => setTimeout(r, 220));

        const countBefore = masterMessages.length;
        masterMessages = mergeMessages(masterMessages, extractCurrentVisibleMessages());
        const newlyAdded = masterMessages.length - countBefore;

        if (newlyAdded > 0 || scroller.scrollHeight > lastScrollHeight) {
          consecutiveStagnantUp = 0;
          lastScrollHeight = scroller.scrollHeight;
          const msg = `Odczytano ${masterMessages.length} wiadomości (+${newlyAdded} ze starszych)...`;
          sendDiagnosticLog('info', msg);
          if (typeof onProgressUpdate === 'function') onProgressUpdate(masterMessages.length, msg);
          chrome.runtime.sendMessage({
            action: 'extractProgress',
            sessionId,
            count: masterMessages.length,
            status: msg
          }).catch(() => {});
        } else {
          consecutiveStagnantUp++;
        }

        if (scroller.scrollTop <= 0 && consecutiveStagnantUp >= 2) {
          break;
        }
      }

      // Phase 2: Scroll DOWN to the bottom to capture all turns in order
      sendDiagnosticLog('info', `Faza 2: Skanowanie w dół do końca konwersacji (odczytano dotychczas: ${masterMessages.length})...`);
      const stepPx = Math.max(450, Math.floor(scroller.clientHeight * 0.75));
      let downAttempts = 0;
      let stagnantDown = 0;
      let lastScrollDown = -1;
      let lastScrollHeightDown = scroller.scrollHeight;

      while (downAttempts < 150 && stagnantDown < 4) {
        downAttempts++;
        lastScrollDown = scroller.scrollTop;
        scroller.scrollTop += stepPx;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise(r => setTimeout(r, 180));

        const countBefore = masterMessages.length;
        masterMessages = mergeMessages(masterMessages, extractCurrentVisibleMessages());
        const newlyAdded = masterMessages.length - countBefore;

        if (newlyAdded > 0 || scroller.scrollHeight > lastScrollHeightDown) {
          stagnantDown = 0;
          lastScrollHeightDown = scroller.scrollHeight;
          const msg = `Odczytano ${masterMessages.length} wiadomości (+${newlyAdded} ze scrolla w dół)...`;
          sendDiagnosticLog('info', msg);
          if (typeof onProgressUpdate === 'function') onProgressUpdate(masterMessages.length, msg);
          chrome.runtime.sendMessage({
            action: 'extractProgress',
            sessionId,
            count: masterMessages.length,
            status: msg
          }).catch(() => {});
        }

        if (scroller.scrollTop === lastScrollDown || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 15) {
          stagnantDown++;
        }
      }

      // Final pass at bottom
      masterMessages = mergeMessages(masterMessages, extractCurrentVisibleMessages());
    }

    // Format output with clean index and timestamp
    const orderedMessages = masterMessages.map((item, idx) => ({
      role: item.role,
      content: item.content,
      timestamp: new Date().toISOString(),
      index: idx
    }));

    // Fallback if needed
    if (orderedMessages.length === 0) {
      extractMessagesAlternative(orderedMessages);
    }

    return orderedMessages;
  }

  // Get element position in DOM (using vertical position on page)
  function getElementPosition(element) {
    try {
      const rect = element.getBoundingClientRect();
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      return rect.top + scrollTop;
    } catch (error) {
      let position = 0;
      let el = element;
      while (el) {
        position += el.offsetTop || 0;
        el = el.offsetParent;
      }
      return position;
    }
  }

  // Extract content from an element, preserving formatting
  function extractContentFromElement(element) {
    const clone = element.cloneNode(true);

    // Remove UI utility buttons and action bars
    const removeSelectors = [
      'button',
      '.action-buttons',
      '.copy-button',
      '.edit-button',
      '.thumb-up',
      '.thumb-down',
      '[aria-label*="Copy"]',
      '[aria-label*="Edit"]',
      '.citation',
      '.source-links'
    ];

    removeSelectors.forEach(selector => {
      const elements = clone.querySelectorAll(selector);
      elements.forEach(el => el.remove());
    });

    // Replace images with clean placeholders
    const images = clone.querySelectorAll('img');
    images.forEach(img => {
      const alt = img.alt || '';
      if (alt) {
        const textNode = document.createTextNode(`[Image: ${alt}]`);
        img.parentNode.replaceChild(textNode, img);
      } else {
        img.remove();
      }
    });

    // Handle thoughts / reasoning collapsible blocks if present
    const thoughts = clone.querySelectorAll('thought, thought-block, [class*="thought"]');
    thoughts.forEach(th => {
      const thText = th.textContent.trim();
      if (thText) {
        const textNode = document.createTextNode(`\n\n> **Thinking Process:**\n> ${thText.replace(/\n/g, '\n> ')}\n\n`);
        th.parentNode?.replaceChild(textNode, th);
      }
    });

    // Handle code blocks
    const codeBlocks = clone.querySelectorAll('pre code, code-block');
    if (codeBlocks.length > 0) {
      codeBlocks.forEach(code => {
        const language = code.className.match(/language-(\w+)/)?.[1] || '';
        const codeText = code.textContent || '';
        code.textContent = `\n\`\`\`${language}\n${codeText}\n\`\`\`\n`;
      });
    }

    // Handle tables
    const tables = clone.querySelectorAll('table');
    tables.forEach(table => {
      const markdownTable = convertTableToMarkdown(table);
      const textNode = document.createTextNode('\n\n' + markdownTable + '\n\n');
      table.parentNode.replaceChild(textNode, table);
    });

    return clone.innerText || clone.textContent || '';
  }

  // Convert HTML table to Markdown table
  function convertTableToMarkdown(table) {
    let markdown = '';
    const rows = table.querySelectorAll('tr');

    rows.forEach((row, rowIndex) => {
      const cells = row.querySelectorAll('th, td');
      const cellTexts = [];

      cells.forEach(cell => {
        cellTexts.push(cell.textContent.trim().replace(/\|/g, '\\|'));
      });

      if (cellTexts.length > 0) {
        markdown += '| ' + cellTexts.join(' | ') + ' |\n';

        if (rowIndex === 0) {
          const separators = cellTexts.map(() => '---');
          markdown += '| ' + separators.join(' | ') + ' |\n';
        }
      }
    });

    return markdown;
  }

  // Fallback alternative extraction
  function extractMessagesAlternative(messages) {
    try {
      const allTextBlocks = document.querySelectorAll('p, pre, div[class*="text"]');
      allTextBlocks.forEach(block => {
        const text = block.textContent.trim();
        if (text.length > 20) {
          messages.push({
            role: 'unknown',
            content: text,
            timestamp: new Date().toISOString()
          });
        }
      });
    } catch (error) {
      console.error('Alternative extraction failed:', error);
    }
  }

  // Generate Markdown format for a conversation
  function generateMarkdown(messages, title, conversationId) {
    let md = `# ${title || 'Gemini Conversation'}\n\n`;
    md += `- **Conversation ID**: \`${conversationId || 'unknown'}\`\n`;
    md += `- **Platform**: Google Gemini\n`;
    md += `- **Export Date**: ${new Date().toISOString()}\n`;
    md += `- **Message Count**: ${messages.length}\n\n`;
    md += `---\n\n`;

    messages.forEach((msg, idx) => {
      const roleIcon = msg.role === 'user' ? '👤 User' : '🤖 Gemini';
      md += `## ${roleIcon}\n\n`;
      md += `${msg.content}\n\n`;
      if (idx < messages.length - 1) {
        md += `---\n\n`;
      }
    });

    return md;
  }

  // ============================================================================
  // SIDEBAR SCANNING & AUTO-SCROLL ENGINE
  // ============================================================================

  let isScanningConversations = false;
  const discoveredSessionsMap = new Map();

  // Preload already discovered sessions from local storage into memory
  try {
    chrome.storage.local.get('geminiSessionList').then(store => {
      if (store && store.geminiSessionList && Array.isArray(store.geminiSessionList)) {
        store.geminiSessionList.forEach((item, idx) => {
          if (item && item.id) {
            discoveredSessionsMap.set(item.id, {
              id: item.id,
              title: item.title,
              url: item.url,
              section: item.section || 'Rozmowa',
              order: typeof item.order === 'number' ? item.order : idx
            });
          }
        });
      }
    }).catch(() => {});
  } catch (_) {}

  // Expand sidebar if collapsed
  function ensureSidebarExpanded() {
    const expandBtn = document.querySelector('button[aria-label*="menu" i], button[aria-label*="side" i], button[data-test-id*="menu" i]');
    if (expandBtn && document.querySelector('a[href*="/app/"]') === null) {
      try {
        expandBtn.click();
      } catch (_) {}
    }
  }

  // Find scrollable container for the conversation list in the sidebar
  function findSidebarScrollContainer() {
    // 1. Direct search inside sidebar container elements
    const sidebar = document.querySelector('side-navigation-v2, mat-sidenav, [role="navigation"], aside, .side-nav-menu-button');
    if (sidebar) {
      const scroller = sidebar.querySelector('infinite-scroller, [class*="infinite-scroller"], [cdkscrollable]');
      if (scroller && (scroller.scrollHeight > scroller.clientHeight || scroller.clientHeight > 0)) {
        return scroller;
      }
    }

    // 2. Search upwards from first chat link
    const firstLink = document.querySelector('side-navigation-v2 a[href*="/app/"], mat-sidenav a[href*="/app/"], a[href*="/app/"]');
    if (firstLink) {
      let current = firstLink.parentElement;
      while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        const overflowY = style.overflowY || '';
        if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
          return current;
        }
        current = current.parentElement;
      }
    }

    return document.querySelector('side-navigation-v2 infinite-scroller, mat-sidenav infinite-scroller, [role="navigation"] infinite-scroller, infinite-scroller');
  }

  // Scan sidebar for all conversation items, with auto-scrolling
  async function scanAndDiscoverAllConversations(autoScroll = true, onProgress = null) {
    if (isScanningConversations) {
      console.log('%c[Gemini Discovery] Skanowanie jest już aktywne w tle.', 'color: #3b82f6;');
      return Array.from(discoveredSessionsMap.values());
    }

    isScanningConversations = true;
    cancelExportRequested = false;
    ensureSidebarExpanded();
    await new Promise(r => setTimeout(r, 400));

    try {
      // 1. Initialise conversations Map with ALL previously discovered items from storage and memory
      const conversations = discoveredSessionsMap;
      try {
        const stored = await chrome.storage.local.get('geminiSessionList');
        if (stored.geminiSessionList && Array.isArray(stored.geminiSessionList)) {
          stored.geminiSessionList.forEach((item, idx) => {
            if (item && item.id) {
              conversations.set(item.id, {
                id: item.id,
                title: item.title,
                url: item.url,
                section: item.section || 'Rozmowa',
                order: typeof item.order === 'number' ? item.order : idx
              });
            }
          });
          console.log(`%c[Gemini Discovery] Wczytano ${conversations.size} wcześniej znanych czatów jako bazę początkową.`, 'color: #3b82f6; font-weight: bold;');
        }
      } catch (_) {}

    let latestSection = '';

    function findPrecedingSection(link) {
      try {
        let el = link;
        while (el && el !== document.body) {
          let prev = el.previousElementSibling;
          while (prev) {
            const headingEl = prev.matches?.('h1, h2, h3, h4, [role="heading"], [class*="heading"], [class*="header"], [class*="section"]')
              ? prev
              : prev.querySelector?.('h1, h2, h3, h4, [role="heading"], [class*="heading"], [class*="header"]');
            const target = headingEl || prev;
            const text = (target.innerText || target.textContent || '').trim();
            if (text && text.length > 1 && text.length < 50 && !prev.querySelector('a[href*="/app/"]')) {
              return text.replace(/\n+/g, ' ');
            }
            prev = prev.previousElementSibling;
          }
          el = el.parentElement;
        }
      } catch (_) {}
      return '';
    }

    function collectVisibleLinks() {
      const links = document.querySelectorAll('a[href*="/app/"]');
      let addedCount = 0;

      links.forEach(link => {
        const href = link.getAttribute('href') || link.href || '';
        const match = href.match(/\/app\/([a-zA-Z0-9_-]+)/);
        if (match) {
          const id = match[1];
          const section = findPrecedingSection(link) || latestSection;
          if (section) latestSection = section;

          if (!conversations.has(id)) {
            const titleEl = link.querySelector('[class*="title"], [class*="text"], span, div');
            let title = titleEl?.innerText ||
                        link.getAttribute('title') ||
                        link.getAttribute('aria-label') ||
                        link.innerText || '';

            title = title.replace(/\n+/g, ' ').trim();
            if (!title || title.length < 2) {
              title = `Gemini Chat ${id.substring(0, 8)}`;
            }

            conversations.set(id, {
              id: id,
              title: title,
              url: link.href || `https://gemini.google.com/app/${id}`,
              section: section || 'Rozmowa',
              order: conversations.size
            });
            addedCount++;
          }
        }
      });

      return addedCount;
    }

    function getCleanList() {
      return Array.from(conversations.values()).map((item, idx) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        section: item.section || 'Rozmowa',
        order: typeof item.order === 'number' ? item.order : idx
      }));
    }

    // Initial collect of currently rendered items
    const initialNew = collectVisibleLinks();
    const cleanInitial = getCleanList();
    try {
      chrome.storage.local.set({
        geminiSessionList: cleanInitial,
        geminiLoadProgress: conversations.size
      });
    } catch (_) {}

    console.log(`%c[Gemini Discovery] Rozpoczęto skanowanie. Wykryto wstępnie: ${conversations.size} czatów (+${initialNew} nowych).`, 'color: #3b82f6; font-weight: bold;');

    if (autoScroll) {
      const container = findSidebarScrollContainer();
      if (container) {
        console.log('%c[Gemini Discovery] Znaleziono kontener boczny:', 'color: #8b5cf6;', container);

        let idleChecksAtBottom = 0;
        let lastHeight = container.scrollHeight;
        const maxSteps = 400; // Allow deep scanning of massive histories

        for (let step = 0; step < maxSteps; step++) {
          if (cancelExportRequested) {
            console.log('%c[Gemini Discovery] Skanowanie zatrzymane przez użytkownika.', 'color: #f59e0b;');
            break;
          }

          // Click any "Show More" / "Więcej" buttons in the sidebar
          const buttons = container.querySelectorAll('button');
          buttons.forEach(btn => {
            const txt = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
            if (txt.includes('more') || txt.includes('więcej') || txt.includes('starsz') || txt.includes('load') || txt.includes('expand')) {
              try {
                btn.click();
                console.log('%c[Gemini Discovery] Kliknięto przycisk rozwijania starszych czatów.', 'color: #8b5cf6;');
              } catch (_) {}
            }
          });

          // Scroll down smoothly
          container.scrollTop += 600;
          container.dispatchEvent(new Event('scroll', { bubbles: true }));

          await new Promise(r => setTimeout(r, 380));
          const newItems = collectVisibleLinks();

          // Check if at or near bottom
          const isAtBottom = (container.scrollTop + container.clientHeight >= container.scrollHeight - 60);

          if (newItems > 0) {
            idleChecksAtBottom = 0;
            const currentList = getCleanList();
            try {
              chrome.storage.local.set({
                geminiSessionList: currentList,
                geminiLoadProgress: conversations.size
              });
            } catch (_) {}

            console.log(
              `%c[Gemini Discovery] Krok ${step + 1}/${maxSteps} | Nowe: +${newItems} | Łącznie: ${conversations.size} | Sekcja: "${latestSection}"`,
              'color: #10b981;'
            );

            if (onProgress) onProgress({ phase: 'scanning', count: conversations.size, section: latestSection });
          }

          // ALWAYS send progress update on every step so the browse.html UI receives continuous live feedback!
          const latestItem = Array.from(conversations.values()).pop();
          chrome.runtime.sendMessage({
            action: 'scanProgress',
            count: conversations.size,
            newItems: newItems,
            step: step + 1,
            maxSteps: maxSteps,
            section: latestSection || 'Rozmowy',
            latestTitle: latestItem ? latestItem.title : '',
            waitingForNetwork: isAtBottom && idleChecksAtBottom > 0,
            retry: idleChecksAtBottom,
            maxRetries: 6,
            isDone: false
          }).catch(() => {});

          if (step % 10 === 0 || newItems > 0) {
            sendDiagnosticLog('info', `Skanowanie paska: krok ${step + 1}/${maxSteps}, wykryto: ${conversations.size} czatów (+${newItems})`);
          }

          if (isAtBottom) {
            // We reached the bottom of current scrollHeight.
            // Gemini needs time to fetch older conversations via network (batchexecute)!
            idleChecksAtBottom++;
            console.log(
              `%c[Gemini Discovery] Oczekiwanie na doładowanie starszych czatów z serwera Google (próba ${idleChecksAtBottom}/6, scroll: ${container.scrollHeight}px)...`,
              'color: #f59e0b;'
            );

            // Nudge scroll to stimulate infinite scroller listeners
            container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight - 200);
            container.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            container.scrollTop = container.scrollHeight;
            container.dispatchEvent(new Event('scroll', { bubbles: true }));

            // Wait up to 1200ms for network response
            await new Promise(r => setTimeout(r, 1200));

            const extraItems = collectVisibleLinks();
            if (extraItems > 0 || container.scrollHeight > lastHeight) {
              console.log(`%c[Gemini Discovery] 🎉 Doładowano kolejną porcję historii! (+${extraItems} czatów, wysokość: ${container.scrollHeight}px)`, 'color: #10b981; font-weight: bold;');
              idleChecksAtBottom = 0;
            }

            // Only break after 6 consecutive verified idle retries at the absolute bottom
            if (idleChecksAtBottom >= 6) {
              console.log('%c[Gemini Discovery] 🏁 Osiągnięto sam początek historii (brak kolejnych czatów po 6 próbach).', 'color: #10b981; font-weight: bold;');
              break;
            }
          } else {
            idleChecksAtBottom = 0;
          }

          lastHeight = container.scrollHeight;
        }
      } else {
        console.warn('%c[Gemini Discovery] Nie znaleziono kontenera paska bocznego.', 'color: #ef4444;');
      }
    }

    const result = getCleanList();

    // Cache final results in storage and clear progress flag
    try {
      chrome.storage.local.set({ geminiSessionList: result });
      chrome.storage.local.remove('geminiLoadProgress');
    } catch (_) {}

    // Send scan complete event
    chrome.runtime.sendMessage({
      action: 'scanComplete',
      count: result.length,
      sessions: result
    }).catch(() => {});

    console.log(`%c[Gemini Discovery] ✅ Zakończono skanowanie. Łącznie unikalnych rozmów w historii: ${result.length}`, 'color: #10b981; font-weight: bold; font-size: 13px;');
    return result;
  } finally {
    isScanningConversations = false;
  }
}

  // ============================================================================
  // SINGLE CONVERSATION FETCHER
  // ============================================================================

  async function fetchConversationData(sessionId, chatUrl) {
    // 1. FAST PATH: Attempt direct background RPC fetch (hNvQHb)
    // Zero flicker, zero scrolling, instant!
    if (typeof GeminiRPCFetcher !== 'undefined') {
      try {
        sendDiagnosticLog('info', `[RPC] Próba natywnego pobrania rozmowy ${sessionId} przez Google RPC (hNvQHb)...`);
        const rpcResult = await GeminiRPCFetcher.fetchConversation(sessionId, {
          limit: 50,
          fetchAll: true,
          onProgress: (count, msg) => {
            sendDiagnosticLog('info', msg);
            chrome.runtime.sendMessage({
              action: 'extractProgress',
              sessionId,
              count,
              status: msg
            }).catch(() => {});
          }
        });

        if (rpcResult && rpcResult.messages && rpcResult.messages.length > 0) {
          sendDiagnosticLog('info', `[RPC] ✅ Sukces! Pobrano ${rpcResult.messages.length} wiadomości bez scrollowania DOM.`);
          return rpcResult;
        }
      } catch (rpcErr) {
        sendDiagnosticLog('warn', `[RPC] Błąd pobierania przez RPC: ${rpcErr.message}. Przełączam na scroller DOM (fallback)...`);
      }
    }

    // 2. FALLBACK PATH: DOM Navigation & Progressive Bidirectional Scrolling
    // (Used if RPC fails or is unavailable)
    sendDiagnosticLog('info', `[DOM Fallback] Nawigacja i ekstrakcja z drzewa DOM dla ${sessionId}...`);
    let title = '';
    const currentPath = window.location.pathname;

    if (!currentPath.includes(sessionId)) {
      // Find link by href or id
      const link = document.querySelector(`a[href*="${sessionId}"]`);
      let linkClicked = false;
      if (link) {
        title = link.getAttribute('title') || link.innerText || '';
        link.click();
        linkClicked = true;
      }

      if (!linkClicked) {
        history.pushState(null, '', chatUrl || `/app/${sessionId}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }

      // Wait for chat DOM to render messages
      await new Promise(r => setTimeout(r, 600));
      for (let w = 0; w < 10; w++) {
        const msgs = document.querySelectorAll('user-query, message-content, [class*="user-query"]');
        if (msgs.length > 0) break;
        await new Promise(r => setTimeout(r, 350));
      }
    }

    // Extract messages using progressive bidirectional extractor
    let messages = [];
    try {
      messages = await progressiveExtractChatMessages(sessionId);
    } catch (_) {
      messages = extractChatMessages();
    }

    if (!title) {
      const titleElem = document.querySelector('conversation-title, [data-test-id="conversation-title"], h1');
      title = titleElem ? titleElem.innerText.trim() : document.title.replace('- Gemini', '').trim() || 'Gemini Chat';
    }

    return {
      conversation_id: sessionId,
      title: title,
      url: chatUrl || `https://gemini.google.com/app/${sessionId}`,
      exported_at: new Date().toISOString(),
      platform: 'gemini',
      model: 'gemini-2.5-pro',
      message_count: messages.length,
      messages: messages
    };
  }

  // ============================================================================
  // ON-PAGE FLOATING HUD OVERLAY
  // ============================================================================

  function createOrUpdateHUD(titleText, statusText, progressPercent, showCancel = true) {
    let hud = document.getElementById('gemini-exporter-hud');
    const safePercent = Math.min(100, Math.max(0, Math.round(progressPercent || 0)));

    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'gemini-exporter-hud';
      hud.style.cssText = `
        position: fixed;
        top: 20px;
        right: 24px;
        width: 380px;
        max-width: calc(100vw - 48px);
        background: rgba(15, 23, 42, 0.94);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border: 1px solid rgba(139, 92, 246, 0.35);
        border-radius: 16px;
        box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.65), 0 0 24px rgba(99, 102, 241, 0.25);
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        padding: 16px 20px;
        box-sizing: border-box;
        color: #f8fafc;
        transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
      `;

      hud.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 18px;">♊</span>
            <strong style="font-size: 13px; font-weight: 700; color: #a5b4fc; letter-spacing: 0.3px;">Gemini Chat Exporter</strong>
            <span style="font-size: 10px; font-weight: 700; background: rgba(99, 102, 241, 0.35); border: 1px solid rgba(139, 92, 246, 0.5); color: #c7d2fe; padding: 1px 6px; border-radius: 6px;">${EXTENSION_VERSION}</span>
          </div>
          <button id="hud-close-btn" title="Ukryj widżet" style="background: rgba(255,255,255,0.08); border: none; font-size: 14px; cursor: pointer; color: #94a3b8; border-radius: 6px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; transition: all 0.2s;">✕</button>
        </div>
        <div id="hud-title-txt" style="font-size: 13px; font-weight: 600; color: #f1f5f9; margin-bottom: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          ${titleText || 'Eksportowanie czatów...'}
        </div>
        <div style="width: 100%; height: 9px; background: rgba(255, 255, 255, 0.12); border-radius: 999px; overflow: hidden; margin-bottom: 8px; box-shadow: inset 0 1px 2px rgba(0,0,0,0.3);">
          <div id="hud-bar-fill" style="width: ${safePercent}%; height: 100%; background: linear-gradient(90deg, #6366f1, #a855f7, #ec4899); border-radius: 999px; transition: width 0.3s ease; box-shadow: 0 0 12px rgba(168, 85, 247, 0.4);"></div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #94a3b8; gap: 8px;">
          <span id="hud-status-txt" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;">${statusText || 'Trwa pobieranie...'}</span>
          <span id="hud-percent-txt" style="font-weight: 700; color: #e2e8f0; min-width: 32px; text-align: right;">${safePercent}%</span>
        </div>
        <div id="hud-cancel-container" style="margin-top: 12px; text-align: right; display: ${showCancel ? 'block' : 'none'};">
          <button id="hud-cancel-btn" style="background: rgba(239, 68, 68, 0.2); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 8px; padding: 6px 14px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.2s;">
            🛑 Zatrzymaj i pobierz ZIP
          </button>
        </div>
      `;

      document.body.appendChild(hud);

      const closeBtn = hud.querySelector('#hud-close-btn');
      if (closeBtn) {
        closeBtn.onmouseenter = () => closeBtn.style.background = 'rgba(255,255,255,0.18)';
        closeBtn.onmouseleave = () => closeBtn.style.background = 'rgba(255,255,255,0.08)';
        closeBtn.onclick = () => {
          hud.style.opacity = '0';
          hud.style.transform = 'translateY(-10px)';
          setTimeout(() => hud.remove(), 300);
        };
      }

      const cancelBtn = hud.querySelector('#hud-cancel-btn');
      if (cancelBtn) {
        cancelBtn.onmouseenter = () => cancelBtn.style.background = 'rgba(239, 68, 68, 0.35)';
        cancelBtn.onmouseleave = () => cancelBtn.style.background = 'rgba(239, 68, 68, 0.2)';
        cancelBtn.onclick = () => {
          cancelExportRequested = true;
          cancelBtn.innerText = 'Zatrzymywanie...';
          cancelBtn.disabled = true;
          cancelBtn.style.opacity = '0.6';
          try {
            chrome.runtime.sendMessage({ action: 'cancelExportFromHUD' }).catch(() => {});
          } catch (_) {}
        };
      }
      return;
    }

    // Smooth partial update if already exists in DOM
    const titleEl = hud.querySelector('#hud-title-txt');
    const statusEl = hud.querySelector('#hud-status-txt');
    const barEl = hud.querySelector('#hud-bar-fill');
    const pctEl = hud.querySelector('#hud-percent-txt');
    const cancelBox = hud.querySelector('#hud-cancel-container');

    if (titleEl && titleText) titleEl.textContent = titleText;
    if (statusEl && statusText) statusEl.textContent = statusText;
    if (barEl) barEl.style.width = `${safePercent}%`;
    if (pctEl) pctEl.textContent = `${safePercent}%`;
    if (cancelBox) cancelBox.style.display = showCancel ? 'block' : 'none';
  }

  function removeHUD() {
    const hud = document.getElementById('gemini-exporter-hud');
    if (hud) {
      hud.style.opacity = '0';
      hud.style.transform = 'translateY(-10px)';
      setTimeout(() => hud.remove(), 300);
    }
  }

  // ============================================================================
  // FULL BULK EXPORT ORCHESTRATION
  // ============================================================================

  async function runBulkExport(format = 'json', autoScroll = true) {
    if (isBulkExportRunning) {
      console.warn('Bulk export already running');
      return;
    }

    if (typeof JSZip === 'undefined') {
      alert('JSZip library is missing. Please reload the extension.');
      return;
    }

    isBulkExportRunning = true;
    cancelExportRequested = false;

    try {
      createOrUpdateHUD('Scanning sidebar history...', 'Discovering past conversations...', 5);

      const conversations = await scanAndDiscoverAllConversations(autoScroll, (prog) => {
        createOrUpdateHUD('Scanning sidebar history...', `Found ${prog.count} conversations...`, 15);
        chrome.runtime.sendMessage({
          action: 'bulkProgress',
          phase: 'scanning',
          count: prog.count
        }).catch(() => {});
      });

      if (conversations.length === 0) {
        const currentMessages = extractChatMessages();
        if (currentMessages.length > 0) {
          conversations.push({
            id: `chat_${Date.now()}`,
            title: document.title.replace('- Gemini', '').trim() || 'Gemini Chat',
            url: window.location.href
          });
        } else {
          createOrUpdateHUD('No conversations found', 'Make sure you are logged into gemini.google.com with active history.', 100, false);
          isBulkExportRunning = false;
          return;
        }
      }

      const zip = new JSZip();
      let exportedCount = 0;
      const total = conversations.length;

      createOrUpdateHUD(`Exporting 0 / ${total} chats...`, 'Starting download loop...', 20);

      for (let i = 0; i < total; i++) {
        if (cancelExportRequested) {
          console.log('Gemini Chat Exporter: Export cancelled by user, packing gathered chats...');
          break;
        }

        const item = conversations[i];
        const progressPercent = Math.round(20 + ((i + 1) / total) * 70);

        createOrUpdateHUD(`[${i + 1}/${total}] ${item.title}`, `Extracting conversation messages...`, progressPercent);

        chrome.runtime.sendMessage({
          action: 'bulkProgress',
          phase: 'exporting',
          current: i + 1,
          total: total,
          percent: progressPercent,
          title: item.title
        }).catch(() => {});

        try {
          const chatRecord = await fetchConversationData(item.id, item.url);
          const safeTitle = sanitizeFilename(`${String(i + 1).padStart(3, '0')}_${item.title}`);

          if (format === 'json') {
            zip.file(`${safeTitle}.json`, JSON.stringify(chatRecord, null, 2));
          } else if (format === 'markdown') {
            zip.file(`${safeTitle}.md`, generateMarkdown(chatRecord.messages, item.title, item.id));
          } else {
            // Plain text
            let text = `${item.title}\n\n`;
            chatRecord.messages.forEach(m => {
              text += `[${m.role}]:\n${m.content}\n\n`;
            });
            zip.file(`${safeTitle}.txt`, text);
          }

          exportedCount++;
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (err) {
          console.error(`Failed to export chat ${item.id}:`, err);
        }
      }

      createOrUpdateHUD('Compressing ZIP archive...', 'Packaging all conversation files...', 95, false);

      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      const timestamp = getTimestamp();
      const zipFilename = `gemini-all-chats-${timestamp}.zip`;

      const blobUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = zipFilename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }, 60000);

      createOrUpdateHUD(
        `🎉 Export Complete!`,
        `Successfully saved ${exportedCount} chats to ${zipFilename}`,
        100,
        false
      );

      chrome.runtime.sendMessage({
        action: 'bulkComplete',
        exportedCount: exportedCount,
        filename: zipFilename
      }).catch(() => {});

      setTimeout(() => {
        removeHUD();
      }, 8000);

    } catch (error) {
      console.error('Bulk export fatal error:', error);
      createOrUpdateHUD('Export Failed', error.message || 'An unexpected error occurred.', 100, false);
    } finally {
      isBulkExportRunning = false;
    }
  }

  // ============================================================================
  // EXTENSION MESSAGING INTERFACE
  // ============================================================================

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log(`%c[Gemini Exporter Content] Odebrano komunikat akcji: ${request.action}`, 'color: #3b82f6; font-weight: bold;');

    if (request.action === 'ping') {
      sendResponse({ pong: true, version: EXTENSION_VERSION, url: window.location.href });
      return true;
    }

    if (request.action === 'navigateToChat') {
      (async () => {
        const sessionId = request.sessionId;
        if (!sessionId) {
          sendResponse({ success: false, clicked: false, reason: 'Brak sessionId' });
          return;
        }

        // 1. Jeśli karta już znajduje się na tym czacie
        if (window.location.pathname.includes(sessionId)) {
          sendDiagnosticLog('info', `Karta jest już na wybranym czacie (${sessionId}).`);
          sendResponse({ success: true, clicked: true, alreadyActive: true });
          return;
        }

        // 2. Bezpośredni link w aktualnym widoku DOM
        let link = document.querySelector(`a[href*="${sessionId}"]`);
        if (link) {
          link.click();
          sendDiagnosticLog('info', `Nawigacja SPA: kliknięto widoczny link w pasku bocznym (${sessionId})`);
          sendResponse({ success: true, clicked: true, method: 'direct-link' });
          return;
        }

        // 3. Sprawdź czy link pojawi się po przewinięciu wirtualnej listy paska bocznego
        const sidebarContainer = findSidebarScrollContainer();
        if (sidebarContainer) {
          ensureSidebarExpanded();
          const initialTop = sidebarContainer.scrollTop;
          let found = false;

          // Przewijaj w dół w krótkich krokach, aby wirtualna lista wyrenderowała element
          for (let step = 0; step < 25; step++) {
            sidebarContainer.scrollTop += 650;
            sidebarContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise(r => setTimeout(r, 120));

            link = document.querySelector(`a[href*="${sessionId}"]`);
            if (link) {
              link.click();
              sendDiagnosticLog('info', `Nawigacja SPA: znaleziono i kliknięto link po przewinięciu paska (krok ${step + 1}, ${sessionId})`);
              found = true;
              sendResponse({ success: true, clicked: true, method: 'sidebar-scroll-down' });
              return;
            }

            if (sidebarContainer.scrollTop + sidebarContainer.clientHeight >= sidebarContainer.scrollHeight - 30) {
              break;
            }
          }

          // Jeśli nie znaleziono w dół, spróbuj wrócić na samą górę
          if (!found && initialTop > 0) {
            sidebarContainer.scrollTop = 0;
            sidebarContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise(r => setTimeout(r, 120));
            link = document.querySelector(`a[href*="${sessionId}"]`);
            if (link) {
              link.click();
              sendDiagnosticLog('info', `Nawigacja SPA: znaleziono link na samej górze paska (${sessionId})`);
              sendResponse({ success: true, clicked: true, method: 'sidebar-scroll-top' });
              return;
            }
          }
        }

        // 4. Spróbuj SPA router transition przez history.pushState + popstate
        try {
          const targetPath = `/app/${sessionId}`;
          window.history.pushState(null, '', targetPath);
          window.dispatchEvent(new PopStateEvent('popstate'));
          window.dispatchEvent(new Event('locationchange'));
          sendDiagnosticLog('info', `Nawigacja SPA: wykonano history.pushState do ${targetPath}`);
          sendResponse({ success: true, clicked: true, method: 'pushState' });
          return;
        } catch (pushErr) {
          sendDiagnosticLog('warn', `Błąd nawigacji pushState: ${pushErr.message}`);
        }

        sendResponse({ success: false, clicked: false, reason: 'Link nie został odnaleziony w pasku bocznym' });
      })();
      return true;
    }

    if (request.action === 'updateHUD') {
      createOrUpdateHUD(request.title, request.status, request.percent, request.showCancel !== false);
      sendResponse({ success: true });
      return true;
    }

    if (request.action === 'removeHUD') {
      removeHUD();
      sendResponse({ success: true });
      return true;
    }

    if (request.action === 'extractMessages' || request.action === 'extractCurrentChat') {
      (async () => {
        try {
          const reqSessionId = request.sessionId || '';
          sendDiagnosticLog('info', `Rozpoczęto zaawansowaną ekstrakcję dla: ${reqSessionId || 'aktywny'} (${window.location.pathname})`);

          const displayTitle = request.title ? `${request.chatPrefix || ''} ${request.title}` : (reqSessionId || 'Czat Gemini');
          createOrUpdateHUD(displayTitle, 'Rozpoczynanie pobierania...', request.percent || 0, true);

          const messages = await progressiveExtractChatMessages(reqSessionId, (count, status) => {
            createOrUpdateHUD(displayTitle, status, request.percent || 0, true);
            chrome.runtime.sendMessage({
              action: 'extractProgress',
              sessionId: reqSessionId,
              count,
              status
            }).catch(() => {});
          });

          const titleElem = document.querySelector('conversation-title, [data-test-id="conversation-title"], h1');
          const title = titleElem ? titleElem.innerText.trim() : document.title.replace('- Gemini', '').trim() || 'Gemini Chat';
          const match = window.location.pathname.match(/\/app\/([a-zA-Z0-9_-]+)/);
          const conversationId = reqSessionId || (match ? match[1] : `chat_${Date.now()}`);

          sendDiagnosticLog('success', `Zakończono ekstrakcję: ${messages.length} wiadomości dla "${title}" (${conversationId})`);

          createOrUpdateHUD(displayTitle, `✅ Pobrano ${messages.length} wiadomości`, request.percent || 0, true);

          sendResponse({
            success: true,
            messages: messages,
            count: messages.length,
            title: title,
            conversationId: conversationId
          });
        } catch (err) {
          sendDiagnosticLog('error', `Błąd ekstrakcji: ${err.message}`);
          createOrUpdateHUD('Błąd ekstrakcji', err.message, request.percent || 0, false);
          sendResponse({
            success: false,
            error: err.message
          });
        }
      })();
      return true;
    }

    if (request.action === 'loadConversations') {
      const autoScroll = request.autoScroll !== false;
      const cached = Array.from(discoveredSessionsMap.values());

      // Respond immediately with currently known list and status so browse.js NEVER times out
      sendResponse({
        success: true,
        started: true,
        isScanning: isScanningConversations,
        count: cached.length,
        sessions: cached
      });

      // Launch full deep discovery in background if not already active
      if (!isScanningConversations) {
        scanAndDiscoverAllConversations(autoScroll).catch(err => {
          console.error('[Gemini Discovery] Błąd skanowania w tle:', err);
        });
      }
      return true;
    }

    if (request.action === 'stopScan') {
      cancelExportRequested = true;
      console.log('%c[Gemini Discovery] Otrzymano sygnał zatrzymania skanowania (stopScan).', 'color: #ef4444; font-weight: bold;');
      sendResponse({ success: true, stopping: true });
      return true;
    }

    if (request.action === 'fetchConversationData') {
      fetchConversationData(request.sessionId, request.url)
        .then(data => {
          sendResponse({
            success: true,
            data: data
          });
        })
        .catch(err => {
          sendResponse({
            success: false,
            error: err.message
          });
        });
      return true;
    }

    if (request.action === 'startBulkExport') {
      runBulkExport(request.format || 'json', request.autoScroll !== false);
      sendResponse({ success: true, started: true });
      return true;
    }

    if (request.action === 'cancelBulkExport') {
      cancelExportRequested = true;
      sendResponse({ success: true, stopping: true });
      return true;
    }

    return true;
  });
}
