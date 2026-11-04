/**
 * Storage Profile Switcher - background service worker.
 *
 * Data model (chrome.storage.local -> "sps_profiles"):
 * {
 *   "<registrable domain>": {
 *     current: "<active profile name>",
 *     data: {
 *       "<profile name>": {
 *         local:   { key: value, ... },   // window.localStorage snapshot
 *         session: { key: value, ... },   // window.sessionStorage snapshot
 *         cookies: [ ...chrome cookie objects... ],
 *         idb:     { "<db name>": { version, stores } },  // IndexedDB snapshot
 *         savedAt: 1780000000000
 *       }
 *     }
 *   }
 * }
 *
 * Switching a profile:
 *   1. snapshot the live page state (localStorage + sessionStorage + IndexedDB)
 *      and the live cookies of the domain into the currently active profile,
 *      so nothing is lost;
 *   2. apply the target profile: write its storage keys into the page, restore
 *      its IndexedDB databases and replace the domain cookies;
 *   3. reload the tab so the app re-reads its own session.
 *
 * IndexedDB matters a lot: Firebase Auth (apob.ai and many other apps) keeps the
 * real session - access + refresh token - in IndexedDB ("firebaseLocalStorageDb"
 * -> "authUser:<apiKey>:[DEFAULT]"), while localStorage only holds a hint
 * ({"firebaseUid": "...", "provider": "google"}). Swapping localStorage alone
 * leaves the old token in place and the app signs the user out.
 */

const STORE_KEY = "sps_profiles";

import { MAMA_BACKUP } from "./heal-data.js";

const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "ne.jp", "or.jp",
  "com.au", "net.au", "org.au", "co.kr", "or.kr", "co.nz", "net.nz",
  "com.br", "com.mx", "com.ar", "com.tr", "com.cn", "com.ua", "com.tw",
  "co.in", "net.in", "co.za", "com.pl", "co.il",
]);

/* ------------------------------------------------------------------ helpers */

function isEmail(str) {
  return typeof str === "string" && str.includes("@") && str.includes(".");
}

function registrableDomain(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname;
    if (host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return host;
    const lastTwo = parts.slice(-2).join(".");
    const idx = parts.length >= 3 && TWO_LEVEL_SUFFIXES.has(lastTwo)
      ? parts.length - 3
      : parts.length - 2;
    return parts.slice(Math.max(idx, 0)).join(".");
  } catch {
    return null;
  }
}

async function getAll() {
  const store = await chrome.storage.local.get(STORE_KEY);
  const profiles = store[STORE_KEY] || {};
  let healed = false;

  if (profiles["apob.ai"] && profiles["apob.ai"].data) {
    const apob = profiles["apob.ai"].data;
    // 1. Restore mama.olga.naz@mail.ru genuine session if it was clobbered by 30secondsofgameplay
    if (MAMA_BACKUP && apob["mama.olga.naz@mail.ru"] && getProfileIdentity(apob["mama.olga.naz@mail.ru"]) === "30secondsofgameplay@gmail.com") {
      apob["mama.olga.naz@mail.ru"] = JSON.parse(JSON.stringify(MAMA_BACKUP));
      healed = true;
    }
    // 2. Clear foreign session from mood-films@yandex.ru so it doesn't cross-login to nazarov
    if (apob["mood-films@yandex.ru"] && getProfileIdentity(apob["mood-films@yandex.ru"]) === "nazarov-mitish-n@mail.ru") {
      delete apob["mood-films@yandex.ru"].idb;
      if (apob["mood-films@yandex.ru"].local) {
        delete apob["mood-films@yandex.ru"].local.auth;
        delete apob["mood-films@yandex.ru"].local.firebaseAuthIsLoggedIn;
      }
      healed = true;
    }
    // 3. Ensure olga.n.az@mail.ru is registered as an alias matching the stored identity
    if (apob["o.n.az@gmail.com"] && !apob["olga.n.az@mail.ru"]) {
      apob["olga.n.az@mail.ru"] = JSON.parse(JSON.stringify(apob["o.n.az@gmail.com"]));
      healed = true;
    }
  }

  for (const domainData of Object.values(profiles)) {
    for (const prof of Object.values((domainData && domainData.data) || {})) {
      if (sanitizeProfile(prof)) {
        healed = true;
      }
    }
  }
  if (healed) {
    await chrome.storage.local.set({ [STORE_KEY]: profiles });
  }
  return profiles;
}

function extractFirebaseUser(prof) {
  if (!prof) return null;
  const idb = prof.idb || {};
  for (const db of Object.values(idb)) {
    for (const store of Object.values((db && db.stores) || {})) {
      for (const val of (store && store.values) || []) {
        if (!val || typeof val !== "object") continue;
        const inner = val.value !== undefined ? val.value : val;
        let obj = inner;
        if (typeof inner === "string") {
          try {
            obj = JSON.parse(inner);
          } catch {
            continue;
          }
        }
        if (obj && typeof obj === "object" && (obj.email || obj.uid || obj.stsTokenManager)) {
          return obj;
        }
      }
    }
  }
  return null;
}

function sanitizeProfile(prof) {
  if (!prof) return false;
  let changed = false;
  const fbUser = extractFirebaseUser(prof);
  if (fbUser) {
    if (!prof.local) {
      prof.local = {};
      changed = true;
    }
    if (prof.local.firebaseAuthIsLoggedIn !== "true") {
      prof.local.firebaseAuthIsLoggedIn = "true";
      changed = true;
    }

    let desiredProv = "password";
    if (Array.isArray(fbUser.providerData) && fbUser.providerData.length > 0) {
      const pId = (fbUser.providerData[0].providerId || "").toLowerCase();
      if (pId.includes("google")) desiredProv = "google";
      else if (pId.includes("password")) desiredProv = "password";
    } else if (fbUser.email && fbUser.email.toLowerCase().endsWith("@gmail.com")) {
      desiredProv = "google";
    }

    if (prof.local.firebaseAuthProvider !== desiredProv) {
      prof.local.firebaseAuthProvider = desiredProv;
      changed = true;
    }
    if (fbUser.uid) {
      const expectedAuth = JSON.stringify({
        firebaseUid: fbUser.uid,
        provider: desiredProv,
      });
      if (prof.local.auth !== expectedAuth) {
        prof.local.auth = expectedAuth;
        changed = true;
      }
    }
    if (prof.local["guestId/v2"] !== undefined) {
      delete prof.local["guestId/v2"];
      changed = true;
    }
    if (prof.local["guestId"] !== undefined) {
      delete prof.local["guestId"];
      changed = true;
    }
  }
  return changed;
}

function parseJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

function getProfileIdentity(state) {
  if (!state) return null;

  // 1. Firebase auth in IDB
  const fbUser = extractFirebaseUser(state);
  if (fbUser) {
    if (fbUser.email) return fbUser.email.toLowerCase();
    if (fbUser.uid) return String(fbUser.uid);
  }

  // 2. localStorage
  const local = state.local || {};
  if (local.user) {
    try {
      const u = typeof local.user === "string" ? JSON.parse(local.user) : local.user;
      if (u && typeof u === "object") {
        if (u.email) return u.email.toLowerCase();
        if (u.id) return String(u.id);
        if (u.uid) return String(u.uid);
      }
    } catch {}
  }
  if (local.auth) {
    try {
      const a = typeof local.auth === "string" ? JSON.parse(local.auth) : local.auth;
      if (a && typeof a === "object") {
        if (a.email) return a.email.toLowerCase();
        if (a.firebaseUid) return String(a.firebaseUid);
      }
    } catch {}
  }

  // 3. Look for JWT in local storage
  for (const val of Object.values(local)) {
    if (typeof val === "string" && val.startsWith("ey") && val.includes(".")) {
      const payload = parseJwtPayload(val);
      if (payload) {
        if (payload.email) return payload.email.toLowerCase();
        if (payload.name && payload.name.includes("@")) return payload.name.toLowerCase();
        if (payload.sub) return String(payload.sub);
        if (payload.user_id) return String(payload.user_id);
        if (payload._id) return String(payload._id);
      }
    }
  }

  return null;
}

async function saveAll(profiles) {
  await chrome.storage.local.set({ [STORE_KEY]: profiles });
}

function cookieUrl(cookie, securePreferred = true) {
  const host = (cookie.domain || "").replace(/^\./, "");
  const scheme = (cookie.secure || securePreferred) ? "https://" : "http://";
  return scheme + host + (cookie.path || "/");
}

async function readCookies(domain) {
  try {
    return await chrome.cookies.getAll({ domain });
  } catch {
    return [];
  }
}

async function clearCookies(domain) {
  const cookies = await readCookies(domain);
  for (const cookie of cookies) {
    try {
      const details = { url: cookieUrl(cookie, true), name: cookie.name };
      if (cookie.storeId) details.storeId = cookie.storeId;
      await chrome.cookies.remove(details);
    } catch {
      /* cookie may already be gone */
    }
    if (!cookie.secure) {
      try {
        const details = { url: cookieUrl(cookie, false), name: cookie.name };
        if (cookie.storeId) details.storeId = cookie.storeId;
        await chrome.cookies.remove(details);
      } catch {}
    }
  }
}

async function applyCookies(cookies) {
  for (const cookie of cookies || []) {
    const details = {
      url: cookieUrl(cookie, true),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
    };
    if (!cookie.hostOnly && cookie.domain) {
      details.domain = cookie.domain.replace(/^\./, "");
    }
    if (cookie.storeId) details.storeId = cookie.storeId;
    if (typeof cookie.expirationDate === "number") details.expirationDate = cookie.expirationDate;
    if (cookie.sameSite && cookie.sameSite !== "unspecified") details.sameSite = cookie.sameSite;
    try {
      await chrome.cookies.set(details);
    } catch {
      try {
        delete details.domain;
        await chrome.cookies.set(details);
      } catch {
        /* cookie rejected (bad domain/path) - the rest still applies */
      }
    }
  }
}

/* --------------------------------------------------- IndexedDB snapshotting */

/**
 * Dumps every IndexedDB database of the current origin to a plain JSON tree.
 * Self-contained on purpose: it is serialised and executed in the page.
 */
async function idbDumpInPage() {
  const MAX_DB_BYTES = 4 * 1024 * 1024;
  const out = {};
  let databases = [];
  try {
    databases = (await indexedDB.databases()) || [];
  } catch {
    databases = [];
  }

  const dbNames = new Set(databases.map((d) => d && d.name).filter(Boolean));
  // Guarantee common auth databases are checked even if indexedDB.databases() missed them
  dbNames.add("firebaseLocalStorageDb");

  for (const name of dbNames) {
    if (!name) continue;
    let db = null;
    try {
      db = await new Promise((resolve, reject) => {
        // Always open WITHOUT version so it opens at current live version without upgrading or blocking
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("blocked"));
        setTimeout(() => reject(new Error("timeout")), 4000);
      });
    } catch {
      continue;
    }

    if (!db) continue;
    const storeNames = Array.from(db.objectStoreNames || []);
    if (storeNames.length === 0) {
      db.close();
      continue;
    }

    const stores = {};
    for (const storeName of storeNames) {
      try {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const keys = await new Promise((resolve, reject) => {
          const r = store.getAllKeys();
          r.onsuccess = () => resolve(r.result || []);
          r.onerror = () => reject(r.error);
        });
        const values = await new Promise((resolve, reject) => {
          const r = store.getAll();
          r.onsuccess = () => resolve(r.result || []);
          r.onerror = () => reject(r.error);
        });
        stores[storeName] = {
          keyPath: store.keyPath === undefined ? null : store.keyPath,
          keys: JSON.parse(JSON.stringify(keys)),
          values: JSON.parse(JSON.stringify(values)),
        };
      } catch {
        /* unreadable store - skip it */
      }
    }
    const currentVersion = db.version || 1;
    db.close();

    let size = 0;
    try {
      size = JSON.stringify(stores).length;
    } catch {
      size = 0;
    }
    if (size > MAX_DB_BYTES) continue; // too heavy to swap, leave it alone
    out[name] = { version: currentVersion, stores };
  }
  return out;
}

/**
 * Restores an IndexedDB snapshot into the current origin.
 * Self-contained on purpose: it is serialised and executed in the page.
 */
async function idbRestoreInPage(snapshot) {
  const restored = [];
  let live = [];
  try {
    live = ((await indexedDB.databases()) || []).map((d) => d.name);
  } catch {
    live = [];
  }

  for (const [name, info] of Object.entries(snapshot || {})) {
    const stores = info.stores || {};
    const existing = live.indexOf(name) !== -1;

    let db = null;
    const openDb = (version) =>
      new Promise((resolve, reject) => {
        const req = version ? indexedDB.open(name, version) : indexedDB.open(name);
        req.onupgradeneeded = () => {
          const created = req.result;
          for (const storeName of Object.keys(stores)) {
            if (created.objectStoreNames.contains(storeName)) continue;
            const keyPath = stores[storeName].keyPath;
            if (keyPath) created.createObjectStore(storeName, { keyPath });
            else created.createObjectStore(storeName);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("blocked"));
        setTimeout(() => reject(new Error("timeout")), 4000);
      });

    try {
      // existing database: open at its live version so the stores stay intact
      db = await openDb(existing ? null : info.version || 1);
    } catch {
      try {
        db = await openDb(null);
      } catch {
        continue;
      }
    }

    for (const storeName of Object.keys(stores)) {
      const data = stores[storeName];
      try {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        store.clear();
        const keys = data.keys || [];
        const values = data.values || [];
        for (let i = 0; i < values.length; i++) {
          if (data.keyPath) store.put(values[i]);
          else store.put(values[i], keys[i]);
        }
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } catch {
        /* ignore this store */
      }
    }
    db.close();
    restored.push(name);
  }
  return restored;
}

/* ------------------------------------------------- page storage read/write */

/**
 * Runs a page-level operation and retries once when the tab turns out to be
 * discarded ("unloaded"): Chromium refuses to inject scripts into such tabs
 * until they are materialised again.
 */
async function runOnPage(tabId, run) {
  try {
    return await run();
  } catch {
    try {
      await chrome.tabs.reload(tabId);
      await new Promise((r) => setTimeout(r, 900));
      return await run();
    } catch {
      return null;
    }
  }
}

async function readPageState(tabId) {
  const empty = { local: {}, session: {}, idb: {} };
  const run = () =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const dump = (store) => {
          const out = {};
          try {
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i);
              if (key === null) continue;
              out[key] = store.getItem(key);
            }
          } catch {
            /* storage unavailable */
          }
          return out;
        };
        return {
          local: dump(window.localStorage),
          session: dump(window.sessionStorage),
        };
      },
    });
  const result = await runOnPage(tabId, run);
  if (!result || !result[0] || !result[0].result) return empty;
  const state = result[0].result;
  state.idb = await readPageIdb(tabId);
  return state;
}

/** Snapshot of the page's IndexedDB databases (empty when unavailable). */
async function readPageIdb(tabId) {
  const result = await runOnPage(tabId, () =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: idbDumpInPage,
    }),
  );
  return (result && result[0] && result[0].result) || {};
}

/** Restores an IndexedDB snapshot into the page (no-op when empty). */
async function restorePageIdb(tabId, snapshot) {
  if (!snapshot || !Object.keys(snapshot).length) return [];
  const result = await runOnPage(tabId, () =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: idbRestoreInPage,
      args: [snapshot],
    }),
  );
  return (result && result[0] && result[0].result) || [];
}

/** Actively clears known auth IndexedDB databases when switching to an empty profile. */
async function clearPageIdb(tabId, dbNames = ["firebaseLocalStorageDb"]) {
  await runOnPage(tabId, () =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (names) => {
        for (const name of names) {
          try {
            const req = indexedDB.open(name);
            const db = await new Promise((resolve, reject) => {
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
              setTimeout(() => reject(new Error("timeout")), 3000);
            });
            for (const storeName of Array.from(db.objectStoreNames || [])) {
              try {
                const tx = db.transaction(storeName, "readwrite");
                tx.objectStore(storeName).clear();
                await new Promise((resolve) => {
                  tx.oncomplete = resolve;
                  tx.onerror = resolve;
                });
              } catch {}
            }
            db.close();
          } catch {}
        }
      },
      args: [dbNames],
    }),
  );
}

async function writePageState(tabId, target, managedKeys) {
  const isAuth = hasSessionData(target) || (target && target.local && target.local.firebaseAuthIsLoggedIn === "true");
  await runOnPage(tabId, () =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (payload, managed, clearGuest) => {
        const removeMissing = (store, wanted) => {
          for (const key of managed) {
            if (!Object.prototype.hasOwnProperty.call(wanted, key)) {
              try {
                store.removeItem(key);
              } catch {
                /* ignore */
              }
            }
          }
        };
        try {
          removeMissing(window.localStorage, payload.local || {});
          for (const [key, value] of Object.entries(payload.local || {})) {
            const strVal = typeof value === "string" ? value : JSON.stringify(value);
            window.localStorage.setItem(key, strVal);
          }
          if (clearGuest) {
            try {
              window.localStorage.removeItem("guestId/v2");
              window.localStorage.removeItem("guestId");
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
        try {
          removeMissing(window.sessionStorage, payload.session || {});
          for (const [key, value] of Object.entries(payload.session || {})) {
            const strVal = typeof value === "string" ? value : JSON.stringify(value);
            window.sessionStorage.setItem(key, strVal);
          }
        } catch {
          /* ignore */
        }
      },
      args: [target, managedKeys, isAuth],
    }),
  );
}

function managedKeysOf(domainData) {
  const keys = new Set();
  for (const profile of Object.values(domainData.data || {})) {
    for (const key of Object.keys((profile && profile.local) || {})) keys.add(key);
    for (const key of Object.keys((profile && profile.session) || {})) keys.add(key);
  }
  return Array.from(keys);
}

/**
 * Does the snapshot contain a real user session?
 *
 * Used as a guard: a page that is logged out still has plenty of state
 * (analytics keys, onboarding flags, ...), so "the storage is not empty" is
 * not enough - we look for an actual identity: a Firebase auth record in
 * IndexedDB or a token-ish key in localStorage.
 */
function hasSessionData(state) {
  if (!state) return false;

  const idb = state.idb || {};
  for (const db of Object.values(idb)) {
    for (const store of Object.values((db && db.stores) || {})) {
      for (const value of store.values || []) {
        if (!value || typeof value !== "object") continue;
        if (typeof value.fbase_key === "string" && value.fbase_key.indexOf("firebase:authUser") === 0) {
          return true;
        }
        const inner = value.value !== undefined ? value.value : value;
        if (inner && typeof inner === "object" && (inner.email || inner.uid)) return true;
        if (inner && typeof inner === "object" && inner.stsTokenManager) return true;
      }
    }
  }

  const local = state.local || {};
  for (const key of Object.keys(local)) {
    if (!/^(auth|token|user|jwt|session|login|access)/i.test(key)) continue;
    const value = local[key];
    if (typeof value === "string" && value.length > 4) return true;
    if (value && typeof value === "object") return true;
  }
  return false;
}

/** Names of the IndexedDB databases the page currently has (no data read). */
async function readPageIdbNames(tabId) {
  const result = await runOnPage(tabId, () =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        try {
          const list = (await indexedDB.databases()) || [];
          return list.map((d) => d.name).filter(Boolean);
        } catch {
          return [];
        }
      },
    }),
  );
  return (result && result[0] && result[0].result) || [];
}

/* ------------------------------------------------------------------ actions */

async function profileState(tabId, url) {
  const domain = registrableDomain(url);
  if (!domain) {
    return { domain: null, current: null, profiles: [], liveIdentity: null };
  }
  const all = await getAll();
  const domainData = all[domain] || { current: null, data: {} };
  const siteIdb = await readPageIdbNames(tabId);

  let liveIdentity = null;
  if (typeof tabId === "number") {
    try {
      const live = await readPageState(tabId);
      liveIdentity = getProfileIdentity(live);
    } catch {}
  }

  return {
    domain,
    current: domainData.current || null,
    liveIdentity,
    siteIdb: siteIdb.length,
    profiles: Object.keys(domainData.data || {}).map((name) => {
      const prof = domainData.data[name] || {};
      const identity = getProfileIdentity(prof);
      return {
        name,
        identity,
        savedAt: prof.savedAt || 0,
        keys: Object.keys(prof.local || {}).length,
        cookies: (prof.cookies || []).length,
        idb: Object.keys(prof.idb || {}).length,
        hasSession: hasSessionData(prof),
      };
    }),
  };
}

async function createProfile(tabId, url, name) {
  const domain = registrableDomain(url);
  const clean = (name || "").trim();
  if (!domain) return { ok: false, error: "Эта страница не поддерживается" };
  if (!clean) return { ok: false, error: "Пустое имя профиля" };

  const all = await getAll();
  const domainData = all[domain] || { current: null, data: {} };
  if (domainData.data[clean]) return { ok: false, error: "Профиль «" + clean + "» уже есть" };

  const live = await readPageState(tabId);
  const cookies = await readCookies(domain);
  const newProf = {
    local: live.local,
    session: live.session,
    cookies,
    idb: live.idb || {},
    savedAt: Date.now(),
  };
  sanitizeProfile(newProf);
  domainData.data[clean] = newProf;
  // The live session now IS this profile, so it becomes the active one.
  domainData.current = clean;
  all[domain] = domainData;
  await saveAll(all);
  return { ok: true };
}

async function switchProfile(tabId, url, name) {
  const domain = registrableDomain(url);
  if (!domain) return { ok: false, error: "Эта страница не поддерживается" };

  const all = await getAll();
  const domainData = all[domain] || { current: null, data: {} };
  const target = domainData.data[name];
  if (!target) return { ok: false, error: "Профиль не найден" };

  // 1. keep the live session in the profile that is active right now
  const currentName = domainData.current;
  const currentProf = currentName ? domainData.data[currentName] : null;

  if (currentProf) {
    const live = await readPageState(tabId);
    if (hasSessionData(live)) {
      const liveIdentity = getProfileIdentity(live);
      const currentIdentity = getProfileIdentity(currentProf);

      let saveTargetName = null;
      const isEmailMismatch =
        isEmail(currentName) &&
        isEmail(liveIdentity) &&
        currentName.toLowerCase() !== liveIdentity.toLowerCase();

      if (!isEmailMismatch && (currentIdentity === liveIdentity || currentName.toLowerCase() === (liveIdentity || "").toLowerCase())) {
        saveTargetName = currentName;
      } else {
        // Identity mismatch: save only to the profile that matches liveIdentity
        for (const [pName, prof] of Object.entries(domainData.data)) {
          if (pName.toLowerCase() === (liveIdentity || "").toLowerCase()) {
            saveTargetName = pName;
            break;
          }
        }
        if (!saveTargetName) {
          for (const [pName, prof] of Object.entries(domainData.data)) {
            if (getProfileIdentity(prof) === liveIdentity && (!isEmail(pName) || pName.toLowerCase() === (liveIdentity || "").toLowerCase())) {
              saveTargetName = pName;
              break;
            }
          }
        }
      }

      if (saveTargetName && domainData.data[saveTargetName]) {
        const cookies = await readCookies(domain);
        const updated = {
          local: live.local,
          session: live.session,
          cookies,
          idb: live.idb || {},
          savedAt: Date.now(),
        };
        sanitizeProfile(updated);
        domainData.data[saveTargetName] = updated;
      }
    } else if (!hasSessionData(currentProf)) {
      domainData.data[currentName] = {
        local: live.local,
        session: live.session,
        cookies: await readCookies(domain),
        idb: live.idb || {},
        savedAt: Date.now(),
      };
    }
  }

  // Ensure target profile is sanitized before applying
  sanitizeProfile(target);

  // 2. Set cookies in cookie jar FIRST (before touching page storage)
  await clearCookies(domain);
  await applyCookies(target.cookies || []);

  domainData.current = name;
  all[domain] = domainData;
  await saveAll(all);

  // Determine current & destination URLs
  let currentUrl = url;
  try {
    const tab = await chrome.tabs.get(tabId);
    currentUrl = tab.url || url;
  } catch {}

  let destUrl = currentUrl;
  let isApob = false;
  const hasAuth = hasSessionData(target);
  if (currentUrl) {
    try {
      const u = new URL(currentUrl);
      isApob = u.hostname === "app.apob.ai" || u.hostname.endsWith(".apob.ai");
      if (isApob) {
        if (hasAuth) {
          destUrl = "https://app.apob.ai/workstation";
        } else {
          destUrl = "https://app.apob.ai/login";
        }
      }
    } catch {}
  }

  // 3. ATOMIC PAGE SWITCH: Freeze live page, update storage & IndexedDB, neutralize unmount sagas
  const managedKeys = managedKeysOf(domainData);
  await runOnPage(tabId, () =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (payload, managed, authActive) => {
        // A. Freeze running page: abort network traffic immediately
        try { window.stop(); } catch {}

        // B. Clear all intervals and timeouts so background polling cannot fire
        try {
          const maxTimerId = window.setTimeout(() => {}, 0);
          for (let i = 0; i <= maxTimerId; i++) {
            window.clearTimeout(i);
            window.clearInterval(i);
          }
        } catch {}

        // C. Neutralize beforeunload / unload / pagehide listeners so unmount sagas cannot fire
        try {
          window.onbeforeunload = null;
          window.onunload = null;
          window.onpagehide = null;
          const stopProp = (e) => {
            try {
              e.stopImmediatePropagation();
              e.stopPropagation();
            } catch {}
          };
          window.addEventListener("beforeunload", stopProp, true);
          window.addEventListener("pagehide", stopProp, true);
          window.addEventListener("unload", stopProp, true);
        } catch {}

        // D. Write localStorage & sessionStorage
        const removeMissing = (store, wanted) => {
          for (const key of managed) {
            if (!Object.prototype.hasOwnProperty.call(wanted, key)) {
              try { store.removeItem(key); } catch {}
            }
          }
        };

        try {
          removeMissing(window.localStorage, payload.local || {});
          for (const [key, value] of Object.entries(payload.local || {})) {
            const strVal = typeof value === "string" ? value : JSON.stringify(value);
            window.localStorage.setItem(key, strVal);
          }
          if (authActive) {
            try {
              window.localStorage.removeItem("guestId/v2");
              window.localStorage.removeItem("guestId");
              window.localStorage.setItem("firebaseAuthIsLoggedIn", "true");
            } catch {}
          }
        } catch {}

        try {
          removeMissing(window.sessionStorage, payload.session || {});
          for (const [key, value] of Object.entries(payload.session || {})) {
            const strVal = typeof value === "string" ? value : JSON.stringify(value);
            window.sessionStorage.setItem(key, strVal);
          }
        } catch {}

        // E. Restore or Clear IndexedDB
        const snapshot = payload.idb || {};
        if (authActive && Object.keys(snapshot).length > 0) {
          for (const [name, info] of Object.entries(snapshot)) {
            const stores = info.stores || {};
            let db = null;
            try {
              db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(name);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                req.onblocked = () => reject(new Error("blocked"));
                setTimeout(() => reject(new Error("timeout")), 3000);
              });
            } catch {
              continue;
            }
            if (!db) continue;

            for (const storeName of Object.keys(stores)) {
              if (!db.objectStoreNames.contains(storeName)) continue;
              const data = stores[storeName];
              try {
                const tx = db.transaction(storeName, "readwrite");
                const store = tx.objectStore(storeName);
                store.clear();
                const keys = data.keys || [];
                const values = data.values || [];
                for (let i = 0; i < values.length; i++) {
                  if (data.keyPath) store.put(values[i]);
                  else store.put(values[i], keys[i]);
                }
                await new Promise((resolve) => {
                  tx.oncomplete = resolve;
                  tx.onerror = resolve;
                  tx.onabort = resolve;
                });
              } catch {}
            }
            try { db.close(); } catch {}
          }
        } else {
          // Clear known auth databases when switching to empty profile
          const clearDbs = ["firebaseLocalStorageDb"];
          for (const name of clearDbs) {
            try {
              const req = indexedDB.open(name);
              const db = await new Promise((resolve, reject) => {
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                setTimeout(() => reject(new Error("timeout")), 2000);
              });
              for (const storeName of Array.from(db.objectStoreNames || [])) {
                try {
                  const tx = db.transaction(storeName, "readwrite");
                  tx.objectStore(storeName).clear();
                  await new Promise((res) => {
                    tx.oncomplete = res;
                    tx.onerror = res;
                  });
                } catch {}
              }
              db.close();
            } catch {}
          }
        }

        // F. Prevent any dying scripts from writing guest tokens or wiping auth
        if (authActive) {
          try {
            const origSet = window.Storage.prototype.setItem;
            const origRemove = window.Storage.prototype.removeItem;
            window.Storage.prototype.setItem = function (k, v) {
              if (k === "guestId/v2" || k === "guestId") return;
              return origSet.apply(this, arguments);
            };
            window.Storage.prototype.removeItem = function (k) {
              if (k === "auth" || k === "firebaseAuthIsLoggedIn" || k === "firebaseAuthProvider") return;
              return origRemove.apply(this, arguments);
            };
          } catch {}
        }

        return { ok: true };
      },
      args: [
        { local: target.local || {}, session: target.session || {}, idb: target.idb || {} },
        managedKeys,
        hasAuth,
      ],
    }),
  );

  // 4. Immediate Navigation / Reload
  try {
    let curUrl = currentUrl;
    try {
      const tab = await chrome.tabs.get(tabId);
      curUrl = tab.url || currentUrl;
    } catch {}

    if (isApob) {
      if (destUrl && curUrl !== destUrl) {
        await chrome.tabs.update(tabId, { url: destUrl });
        return { ok: true };
      }
    }
    await chrome.tabs.reload(tabId);
  } catch {}
  return { ok: true };
}

async function deleteProfile(url, name) {
  const domain = registrableDomain(url);
  if (!domain) return { ok: false };
  const all = await getAll();
  const domainData = all[domain];
  if (!domainData) return { ok: false };
  delete (domainData.data || {})[name];
  if (domainData.current === name) {
    domainData.current = Object.keys(domainData.data || {})[0] || null;
  }
  if (!Object.keys(domainData.data || {}).length) delete all[domain];
  else all[domain] = domainData;
  await saveAll(all);
  return { ok: true };
}

async function renameProfile(url, from, to) {
  const domain = registrableDomain(url);
  const clean = (to || "").trim();
  if (!domain || !clean) return { ok: false };
  const all = await getAll();
  const domainData = all[domain];
  if (!domainData || !domainData.data[from]) return { ok: false };
  if (domainData.data[clean]) return { ok: false, error: "Имя уже занято" };
  const rebuilt = {};
  for (const [key, value] of Object.entries(domainData.data)) {
    rebuilt[key === from ? clean : key] = value;
  }
  domainData.data = rebuilt;
  if (domainData.current === from) domainData.current = clean;
  all[domain] = domainData;
  await saveAll(all);
  return { ok: true };
}

/** Snapshot the live session into a profile without switching (used by "sync"). */
async function syncProfile(tabId, url, name) {
  const domain = registrableDomain(url);
  if (!domain) return { ok: false, error: "Эта страница не поддерживается" };
  const all = await getAll();
  const domainData = all[domain] || { current: null, data: {} };
  const live = await readPageState(tabId);
  const existing = domainData.data[name];

  const liveIdentity = getProfileIdentity(live);

  // Refuse to replace a working profile with an empty one - that is what
  // silently destroys a captured session.
  if (existing && hasSessionData(existing) && !hasSessionData(live)) {
    return {
      ok: false,
      error: "Страница сейчас не авторизована — профиль не перезаписан",
    };
  }

  // Cross-account guard: if profile name is an email and live page is logged in with a DIFFERENT email, warn!
  if (isEmail(name) && isEmail(liveIdentity) && name.toLowerCase() !== liveIdentity.toLowerCase()) {
    return {
      ok: false,
      error: `На странице открыт аккаунт «${liveIdentity}», а профиль называется «${name}». Войдите под нужным аккаунтом на сайте перед сохранением.`,
    };
  }

  const updated = {
    local: live.local,
    session: live.session,
    cookies: await readCookies(domain),
    idb: live.idb || {},
    savedAt: Date.now(),
  };
  sanitizeProfile(updated);
  domainData.data[name] = updated;
  domainData.current = name;
  all[domain] = domainData;
  await saveAll(all);
  return { ok: true, identity: getProfileIdentity(updated) };
}

/* ------------------------------------------------------------- message API */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const tabId = message.tabId;
    let url = message.url;
    if (!url && typeof tabId === "number") {
      try {
        const tab = await chrome.tabs.get(tabId);
        url = tab.url;
      } catch {
        url = null;
      }
    }
    switch (message.action) {
      case "state":
        sendResponse(await profileState(tabId, url));
        break;
      case "create":
        sendResponse(await createProfile(tabId, url, message.name));
        break;
      case "switch":
        sendResponse(await switchProfile(tabId, url, message.name));
        break;
      case "delete":
        sendResponse(await deleteProfile(url, message.name));
        break;
      case "rename":
        sendResponse(await renameProfile(url, message.from, message.to));
        break;
      case "sync":
        sendResponse(await syncProfile(tabId, url, message.name));
        break;
      case "exportProfiles": {
        const all = await getAll();
        sendResponse({ ok: true, data: all, timestamp: Date.now() });
        break;
      }
      case "importProfiles": {
        try {
          const incoming = message.data;
          if (!incoming || typeof incoming !== "object") {
            sendResponse({ ok: false, error: "Некорректный формат файла бэкапа" });
            break;
          }
          const all = await getAll();
          let addedCount = 0;
          let updatedCount = 0;

          for (const [domain, domainData] of Object.entries(incoming)) {
            if (!domain || !domainData || typeof domainData !== "object") continue;
            if (!all[domain]) {
              all[domain] = { current: domainData.current || null, data: {} };
            }
            const currentDomainProfs = all[domain].data || {};
            const incomingProfs = domainData.data || {};

            for (const [pName, pData] of Object.entries(incomingProfs)) {
              if (!pName || !pData || typeof pData !== "object") continue;
              sanitizeProfile(pData);

              if (!currentDomainProfs[pName]) {
                currentDomainProfs[pName] = pData;
                addedCount++;
              } else {
                const localSaved = currentDomainProfs[pName].savedAt || 0;
                const incomingSaved = pData.savedAt || 0;
                const localHasAuth = hasSessionData(currentDomainProfs[pName]);
                const incomingHasAuth = hasSessionData(pData);

                if (!localHasAuth && incomingHasAuth) {
                  currentDomainProfs[pName] = pData;
                  updatedCount++;
                } else if (incomingSaved > localSaved) {
                  currentDomainProfs[pName] = pData;
                  updatedCount++;
                }
              }
            }
            all[domain].data = currentDomainProfs;
            if (!all[domain].current && domainData.current) {
              all[domain].current = domainData.current;
            }
          }

          await saveAll(all);
          sendResponse({ ok: true, addedCount, updatedCount });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || "Ошибка при импорте бэкапа" });
        }
        break;
      }
      case "getVersion":
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
        break;
      case "reload":
        sendResponse({ ok: true });
        setTimeout(() => chrome.runtime.reload(), 50);
        break;
      default:
        sendResponse({ ok: false, error: "unknown action" });
    }
  })();
  return true;
});
