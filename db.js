// db.js - IndexedDB storage manager for Gemini Chat Exporter
// Persists scraped conversations locally for incremental, resumable, and instant offline exports

const DB_NAME = 'GeminiChatExporterDB';
const DB_VERSION = 2;
const STORE_NAME = 'conversations';
const SESSIONS_STORE = 'sessions';

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('cached_at', 'cached_at', { unique: false });
        store.createIndex('title', 'title', { unique: false });
      }
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const sessStore = db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
        sessStore.createIndex('order', 'order', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('[Gemini Exporter DB] Błąd otwierania IndexedDB:', event.target.error);
      reject(new Error('IndexedDB error: ' + event.target.error));
    };
  });
}

// Save or update a single conversation record in IndexedDB
async function saveChatToDB(chatData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const record = {
      id: chatData.conversation_id || chatData.id,
      conversation_id: chatData.conversation_id || chatData.id,
      title: chatData.title || '',
      url: chatData.url || '',
      exported_at: chatData.exported_at || new Date().toISOString(),
      cached_at: new Date().toISOString(),
      platform: chatData.platform || 'gemini',
      model: chatData.model || 'gemini-2.5-pro',
      message_count: chatData.message_count || (chatData.messages ? chatData.messages.length : 0),
      messages: chatData.messages || []
    };

    const req = store.put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = () => reject(req.error);
  });
}

// Get a single conversation from IndexedDB by ID
async function getChatFromDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// Get all conversations stored in IndexedDB
async function getAllChatsFromDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// Get a lightweight Map of cached IDs -> { message_count, cached_at, title } for instant UI rendering
async function getCachedChatMap() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const map = new Map();
      (req.result || []).forEach(item => {
        map.set(item.id, {
          message_count: item.message_count || (item.messages ? item.messages.length : 0),
          cached_at: item.cached_at,
          title: item.title
        });
      });
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

// Count total conversations in IndexedDB
async function countChatsInDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

// Delete a conversation from IndexedDB
async function deleteChatFromDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// Clear all conversations in IndexedDB
async function clearAllChatsFromDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// Save discovered sessions (sidebar metadata) in IndexedDB
async function saveDiscoveredSessionsToDB(sessions) {
  if (!sessions || !Array.isArray(sessions) || sessions.length === 0) return 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readwrite');
    const store = tx.objectStore(SESSIONS_STORE);
    for (const session of sessions) {
      if (session && session.id) {
        store.put(session);
      }
    }
    tx.oncomplete = () => resolve(sessions.length);
    tx.onerror = () => reject(tx.error);
  });
}

// Get all discovered sessions from IndexedDB
async function getAllDiscoveredSessionsFromDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    const store = tx.objectStore(SESSIONS_STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = req.result || [];
      items.sort((a, b) => (a.order || 0) - (b.order || 0));
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

