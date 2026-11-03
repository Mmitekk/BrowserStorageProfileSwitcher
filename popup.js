const els = {
  domain: document.getElementById("domain"),
  current: document.getElementById("current"),
  liveUser: document.getElementById("liveUser"),
  profiles: document.getElementById("profiles"),
  empty: document.getElementById("empty"),
  name: document.getElementById("name"),
  create: document.getElementById("create"),
  status: document.getElementById("status"),
};

let activeTabId = null;

function isEmail(str) {
  return typeof str === "string" && str.includes("@") && str.includes(".");
}

function setStatus(text, isError) {
  els.status.textContent = text || "";
  els.status.classList.toggle("error", !!isError);
}

function send(action, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      Object.assign({ action, tabId: activeTabId }, payload || {}),
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      },
    );
  });
}

async function refresh() {
  const state = await send("state");
  if (!state || !state.domain) {
    els.domain.textContent = "Страница не поддерживается";
    els.current.textContent = "Активный профиль: —";
    els.profiles.innerHTML = "";
    els.empty.style.display = "block";
    return;
  }
  els.domain.textContent = state.domain;
  els.current.innerHTML = state.current
    ? "Активный профиль: <b>" + escapeHtml(state.current) + "</b>"
    : "Активный профиль: <b>—</b>";

  if (els.liveUser) {
    els.liveUser.innerHTML = state.liveIdentity
      ? "На странице: <b class='live-badge'>" + escapeHtml(state.liveIdentity) + "</b>"
      : "На странице: <span class='dim'>не авторизован</span>";
  }

  els.profiles.innerHTML = "";
  els.empty.style.display = state.profiles.length ? "none" : "block";

  for (const profile of state.profiles) {
    const li = document.createElement("li");
    if (profile.name === state.current) li.classList.add("active");

    const nameBtn = document.createElement("button");
    nameBtn.className = "name";
    nameBtn.textContent = profile.name;
    nameBtn.title = profile.name === state.current ? "активный профиль" : "переключиться на этот профиль";

    if (profile.identity && isEmail(profile.name) && isEmail(profile.identity) && profile.name.toLowerCase() !== profile.identity.toLowerCase()) {
      const mismatch = document.createElement("span");
      mismatch.className = "mismatch-badge";
      mismatch.textContent = "сессия: " + profile.identity;
      mismatch.title = "Внимание: в профиле сохранён аккаунт " + profile.identity;
      nameBtn.appendChild(mismatch);
    }
    if (profile.name !== state.current) {
      nameBtn.addEventListener("click", async () => {
        setStatus("Переключаю на «" + profile.name + "»…");
        const res = await send("switch", { name: profile.name });
        if (!res.ok) {
          setStatus(res.error || "Не удалось переключить", true);
        } else {
          setStatus("");
          window.close();
        }
      });
    }

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent =
      profile.keys + " кл." +
      (profile.cookies ? ", " + profile.cookies + " к." : "") +
      (profile.idb ? ", " + profile.idb + " БД" : "");

    // The site stores something in IndexedDB, but this profile has no snapshot of it:
    // switching to it would leave a foreign session behind and log the user out.
    if (state.siteIdb && !profile.idb) {
      const warn = document.createElement("span");
      warn.className = "warn";
      warn.textContent = "!";
      warn.title =
        "Сайт хранит сессию в IndexedDB, а в этом профиле её нет. Залогинься этим аккаунтом и нажми ↻, чтобы перезаписать профиль.";
      li.appendChild(warn);
    } else if (profile.hasSession === false) {
      const warn = document.createElement("span");
      warn.className = "warn";
      warn.textContent = "!";
      warn.title =
        "В этом профиле нет сессии — переключение на него разлогинит. Залогинься этим аккаунтом и нажми ↻.";
      li.appendChild(warn);
    }

    const syncBtn = document.createElement("button");
    syncBtn.className = "icon-btn";
    syncBtn.textContent = "↻";
    syncBtn.title = "Сохранить текущую сессию сайта в этот профиль";
    syncBtn.addEventListener("click", async () => {
      const res = await send("sync", { name: profile.name });
      if (res.ok) {
        setStatus("Профиль «" + profile.name + "» обновлён");
        refresh();
      } else {
        setStatus(res.error || "Не удалось обновить", true);
      }
    });

    const renameBtn = document.createElement("button");
    renameBtn.className = "icon-btn";
    renameBtn.textContent = "✎";
    renameBtn.title = "Переименовать";
    renameBtn.addEventListener("click", async () => {
      const next = window.prompt("Новое имя профиля", profile.name);
      if (!next || next === profile.name) return;
      const res = await send("rename", { from: profile.name, to: next });
      if (res.ok) refresh();
      else setStatus(res.error || "Не удалось переименовать", true);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.textContent = "✕";
    delBtn.title = "Удалить профиль";
    delBtn.addEventListener("click", async () => {
      if (!window.confirm("Удалить профиль «" + profile.name + "»?")) return;
      const res = await send("delete", { name: profile.name });
      if (res.ok) refresh();
      else setStatus(res.error || "Не удалось удалить", true);
    });

    li.append(nameBtn, meta, syncBtn, renameBtn, delBtn);
    els.profiles.appendChild(li);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

async function createProfile() {
  const name = els.name.value.trim();
  if (!name) {
    setStatus("Введи имя профиля", true);
    return;
  }
  const res = await send("create", { name });
  if (!res.ok) {
    setStatus(res.error || "Не удалось создать профиль", true);
    return;
  }
  els.name.value = "";
  setStatus("Профиль «" + name + "» создан");
  refresh();
}

async function checkServiceWorkerVersion() {
  const manifestVersion = chrome.runtime.getManifest().version;
  const tag = document.getElementById("versionTag");
  if (tag) tag.textContent = "v" + manifestVersion;

  try {
    const res = await send("getVersion");
    if (!res || !res.ok || res.version !== manifestVersion) {
      console.warn("Service worker version mismatch: running", res && res.version, "manifest is", manifestVersion);
      setStatus("Обновление Service Worker (v" + manifestVersion + ")…");
      setTimeout(() => {
        chrome.runtime.reload();
      }, 300);
      return false;
    }
  } catch (e) {
    console.warn("Failed to check SW version, reloading extension:", e);
    chrome.runtime.reload();
    return false;
  }
  return true;
}

async function init() {
  const isUpToDate = await checkServiceWorkerVersion();
  if (!isUpToDate) return;

  // ?tabId= lets the popup be opened for a specific tab (bookmark / debugging).
  const forced = Number(new URLSearchParams(location.search).get("tabId"));
  let tab = null;
  if (Number.isInteger(forced) && forced > 0) {
    try {
      tab = await chrome.tabs.get(forced);
    } catch {
      tab = null;
    }
  }
  if (!tab) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active || null;
  }
  activeTabId = tab ? tab.id : null;
  if (!tab) {
    els.domain.textContent = "Нет активной вкладки";
    return;
  }
  await refresh();
}

const reloadExtBtn = document.getElementById("reloadExtBtn");
if (reloadExtBtn) {
  reloadExtBtn.addEventListener("click", () => {
    setStatus("Перезагрузка расширения…");
    setTimeout(() => {
      chrome.runtime.reload();
    }, 150);
  });
}

els.create.addEventListener("click", createProfile);
els.name.addEventListener("keydown", (event) => {
  if (event.key === "Enter") createProfile();
});

init();
