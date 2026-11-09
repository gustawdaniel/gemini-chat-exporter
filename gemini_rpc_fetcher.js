/**
 * Gemini RPC Fetcher
 * High-performance, zero-flicker background conversation fetcher using
 * Google Gemini's native WIZ batchexecute RPC endpoint (hNvQHb).
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GeminiRPCFetcher = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class GeminiRPCFetcher {
    /**
     * Resolves the CSRF token (SNlM0e) and build label (cfb2h).
     * Inspects window.WIZ_global_data, DOM script tags, or triggers an isolated-world bridge.
     */
    static async getTokens() {
      // 1. Direct window check (when running in page context or main world)
      if (typeof window !== 'undefined' && window.WIZ_global_data) {
        const at = window.WIZ_global_data.SNlM0e;
        const bl = window.WIZ_global_data.cfb2h || 'boq_assistant-bard-web-server';
        if (at) return { at, bl };
      }

      // 2. Scan DOM <script> elements (works in Chrome extension isolated worlds!)
      if (typeof document !== 'undefined') {
        const scripts = document.querySelectorAll('script');
        for (let i = 0; i < scripts.length; i++) {
          const text = scripts[i].textContent || '';
          if (text.includes('SNlM0e')) {
            const atMatch = text.match(/["']SNlM0e["']\s*:\s*["']([^"']+)["']/);
            const blMatch = text.match(/["']cfb2h["']\s*:\s*["']([^"']+)["']/);
            if (atMatch && atMatch[1]) {
              return {
                at: atMatch[1],
                bl: (blMatch && blMatch[1]) || 'boq_assistant-bard-web-server'
              };
            }
          }
        }
      }

      // 3. Fallback: inject a temporary bridge script into DOM
      return new Promise((resolve) => {
        if (typeof document === 'undefined') return resolve(null);

        const eventName = '__gemini_rpc_tokens_' + Math.random().toString(36).substring(2);
        const handler = (e) => {
          window.removeEventListener(eventName, handler);
          resolve(e.detail);
        };
        window.addEventListener(eventName, handler);

        const script = document.createElement('script');
        script.textContent = `
          try {
            const data = window.WIZ_global_data || {};
            window.dispatchEvent(new CustomEvent('${eventName}', {
              detail: {
                at: data.SNlM0e || null,
                bl: data.cfb2h || 'boq_assistant-bard-web-server'
              }
            }));
          } catch(e) {
            window.dispatchEvent(new CustomEvent('${eventName}', { detail: null }));
          }
        `;
        (document.head || document.documentElement).appendChild(script);
        script.remove();

        // Timeout fallback
        setTimeout(() => {
          window.removeEventListener(eventName, handler);
          resolve(null);
        }, 1500);
      });
    }

    /**
     * Parses chunked batchexecute response from Google.
     * Google sends: )]}'\n<byte_length>\n[[...]]\n<byte_length>\n...
     */
    static parseBatchExecuteResponse(rawText) {
      if (!rawText) return null;
      const lines = rawText.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const rpcResult = parsed[0];
              // Format: ["wrb.fr", "hNvQHb", "JSON_STRING_DATA", ...]
              if (rpcResult && rpcResult[1] === 'hNvQHb' && rpcResult[2]) {
                return JSON.parse(rpcResult[2]);
              }
              // Check other entries if batched
              for (const entry of parsed) {
                if (Array.isArray(entry) && entry[1] === 'hNvQHb' && entry[2]) {
                  return JSON.parse(entry[2]);
                }
              }
            }
          } catch (e) {
            // Continue parsing other lines
          }
        }
      }
      return null;
    }

    /**
     * Extracts clean message turns from the inner chat data structure.
     */
    static extractTurns(chatData, rawConvId) {
      if (!chatData || !Array.isArray(chatData[0])) {
        return [];
      }

      const turns = chatData[0];
      const messages = [];
      let stepIndex = 0;

      for (let t = 0; t < turns.length; t++) {
        const turn = turns[t];
        if (!turn) continue;

        // Turn structure:
        // turn[0] = User turn metadata [conv_id, user_turn_id] e.g. ["c_...", "r_..."]
        // turn[1] = Assistant response metadata e.g. ["c_...", "r_...", "rc_..."]
        // turn[2] = User query content array: turn[2][0][0] = text
        // turn[3] = Assistant response drafts array: turn[3][0][0][1][0] = markdown text
        // turn[4] = Server timestamps [seconds, nanos]

        // 1. Timestamp calculation
        let isoTimestamp = new Date().toISOString();
        if (turn[4] && typeof turn[4][0] === 'number') {
          const seconds = turn[4][0];
          const nanos = turn[4][1] || 0;
          isoTimestamp = new Date(seconds * 1000 + Math.round(nanos / 1e6)).toISOString();
        }

        // 2. User Message
        const userTurnId = (turn[0] && turn[0][1]) || `${rawConvId}_u_${t}`;
        let userText = '';
        if (turn[2] && Array.isArray(turn[2][0])) {
          userText = turn[2][0][0] || '';
        } else if (typeof turn[2] === 'string') {
          userText = turn[2];
        }

        if (userText) {
          messages.push({
            id: userTurnId,
            role: 'user',
            content: userText.trim(),
            timestamp: isoTimestamp,
            index: stepIndex++
          });
        }

        // 3. Assistant Message
        let assistantText = '';
        let assistantId = `${rawConvId}_a_${t}`;

        if (turn[3] && Array.isArray(turn[3][0]) && Array.isArray(turn[3][0][0])) {
          const primaryDraft = turn[3][0][0];
          assistantId = primaryDraft[0] || (turn[1] && turn[1][2]) || assistantId;
          if (Array.isArray(primaryDraft[1]) && primaryDraft[1][0]) {
            assistantText = primaryDraft[1][0];
          }
        } else if (turn[1] && turn[1][2]) {
          assistantId = turn[1][2];
        }

        if (assistantText) {
          messages.push({
            id: assistantId,
            role: 'assistant',
            content: assistantText.trim(),
            timestamp: isoTimestamp,
            index: stepIndex++
          });
        }
      }

      return messages;
    }

    /**
     * Fetches conversation details via Google Gemini batchexecute RPC (hNvQHb).
     * @param {string} sessionId - e.g. "f4859b9b0791c5d6" or "c_f4859b9b0791c5d6"
     * @param {object} options - { limit: 50, fetchAll: true, onProgress: fn }
     * @returns {Promise<object|null>} Complete normalized conversation or null on RPC failure.
     */
    static async fetchConversation(sessionId, options = {}) {
      const cleanId = sessionId.replace(/^c_/, '');
      const convId = `c_${cleanId}`;
      const limit = options.limit || 50;

      const tokens = await this.getTokens();
      if (!tokens || !tokens.at) {
        console.warn('[GeminiRPCFetcher] Cannot fetch via RPC: SNlM0e token not found.');
        return null;
      }

      let allMessages = [];
      let cursor = null;
      let page = 0;
      const maxPages = options.fetchAll ? 20 : 1;

      while (page < maxPages) {
        page++;
        const payload = [[["hNvQHb", JSON.stringify([convId, limit, cursor]), null, "generic"]]];
        const body = new URLSearchParams({
          'f.req': JSON.stringify(payload),
          'at': tokens.at
        });

        const url = `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&bl=${encodeURIComponent(tokens.bl)}&rt=c&_reqid=${Date.now() % 100000}`;

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
          },
          body: body.toString()
        });

        if (!res.ok) {
          console.warn(`[GeminiRPCFetcher] HTTP error ${res.status} ${res.statusText} fetching ${convId}`);
          return null;
        }

        const text = await res.text();
        const chatData = this.parseBatchExecuteResponse(text);

        if (!chatData) {
          console.warn(`[GeminiRPCFetcher] Failed to parse RPC response for ${convId}`);
          return null;
        }

        const pageMessages = this.extractTurns(chatData, cleanId);
        if (pageMessages.length === 0 && allMessages.length === 0) {
          return null;
        }

        // Prepend older messages when paginating backwards
        if (cursor) {
          allMessages = pageMessages.concat(allMessages);
        } else {
          allMessages = pageMessages;
        }

        // Check for continuation cursor
        const nextCursor = (typeof chatData[1] === 'string' && chatData[1]) || (typeof chatData[2] === 'string' && chatData[2]) || null;
        if (!nextCursor || nextCursor === cursor) {
          break;
        }
        cursor = nextCursor;

        if (typeof options.onProgress === 'function') {
          options.onProgress(allMessages.length, `Pobrano ${allMessages.length} wiadomości przez RPC...`);
        }
      }

      // Re-index steps
      allMessages.forEach((m, idx) => { m.index = idx; });

      // Title heuristic from first user turn
      let title = `Gemini ${cleanId.substring(0, 8)}`;
      const firstUserMsg = allMessages.find(m => m.role === 'user');
      if (firstUserMsg && firstUserMsg.content) {
        const firstLine = firstUserMsg.content.split('\n')[0].trim();
        title = firstLine.substring(0, 100);
      }

      return {
        conversation_id: cleanId,
        title: title,
        url: `https://gemini.google.com/app/${cleanId}`,
        exported_at: new Date().toISOString(),
        platform: 'gemini',
        model: 'gemini-2.5-pro',
        message_count: allMessages.length,
        messages: allMessages
      };
    }
  }

  return GeminiRPCFetcher;
});
