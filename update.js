/**
 * F5 Variable Resolver — окно обновления.
 *
 * Шаги:
 *   1) Получить FileSystemDirectoryHandle папки расширения (из IndexedDB или picker).
 *   2) Запросить readwrite-разрешение, если оно не активно в текущей сессии.
 *   3) Скачать zipball ветки main с GitHub.
 *   4) Распаковать через fflate (только подпапку с manifest.json).
 *   5) Записать файлы в папку расширения, перезаписывая существующие.
 *   6) chrome.runtime.reload().
 */

'use strict';

const REPO_OWNER = 'motlich1998-dotcom';
const REPO_NAME = 'F5---';
const BRANCH = 'main';
const ZIP_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/zipball/${BRANCH}`;
const MANIFEST_RAW = 'https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME
  + '/main/F5%20%D0%A0%D0%B0%D1%81%D1%88%D0%B8%D1%84%D1%80%D0%BE%D0%B2%D0%BA%D0%B0%20%D0%BF%D0%B5%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%BD%D1%8B%D1%85%20-%20%D1%80%D0%B0%D1%81%D1%88%D0%B8%D1%80%D0%B5%D0%BD%D0%B8%D0%B5/manifest.json';
const EXT_FOLDER_NAME = 'F5 Расшифровка переменных - расширение';
const RELEASE_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

// -------- IndexedDB-хранилище для DirectoryHandle --------

const IDB_NAME = 'f5vr-updater';
const IDB_STORE = 'handles';
const IDB_KEY = 'extDir';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key) {
  return openIdb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const r = tx.objectStore(IDB_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function idbPut(key, value) {
  return openIdb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbDelete(key) {
  return openIdb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// -------- DOM-хелперы --------

const $ = (sel) => document.querySelector(sel);

const ui = {
  versions: $('#versions'),
  bindCard: $('#bindCard'),
  bindBtn: $('#bindBtn'),
  progressCard: $('#progressCard'),
  status: $('#status'),
  bar: $('#bar'),
  doneCard: $('#doneCard'),
  doneText: $('#doneText'),
  closeBtn: $('#closeBtn'),
  errorCard: $('#errorCard'),
  errorText: $('#errorText'),
  retryBtn: $('#retryBtn'),
  rebindBtn: $('#rebindBtn'),
  manualBtn: $('#manualBtn'),
  manualLink: $('#manualLink')
};

function show(card) {
  for (const el of [ui.bindCard, ui.progressCard, ui.doneCard, ui.errorCard]) {
    if (!el) continue;
    el.hidden = (el !== card);
  }
}

function setStep(name, state) {
  const li = document.querySelector('.up-step[data-step="' + name + '"]');
  if (!li) return;
  li.classList.remove('is-active', 'is-done', 'is-error');
  if (state) li.classList.add('is-' + state);
}

function resetSteps() {
  document.querySelectorAll('.up-step').forEach((li) => {
    li.classList.remove('is-active', 'is-done', 'is-error');
  });
}

function setStatus(text) {
  if (ui.status) ui.status.textContent = text;
}

function setBar(percent) {
  if (ui.bar) ui.bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
}

function showError(message, opts) {
  opts = opts || {};
  ui.errorText.textContent = message;
  ui.rebindBtn.style.display = opts.allowRebind === false ? 'none' : '';
  show(ui.errorCard);
}

function fillVersions(currentVersion, availableVersion) {
  if (!ui.versions) return;
  if (availableVersion && availableVersion !== currentVersion) {
    ui.versions.innerHTML = 'установлена <b>v' + currentVersion + '</b> → доступна <b>v' + availableVersion + '</b>';
  } else if (availableVersion) {
    ui.versions.innerHTML = 'установлена <b>v' + currentVersion + '</b>';
  } else {
    ui.versions.innerHTML = 'установлена <b>v' + currentVersion + '</b>';
  }
}

// -------- Получение/валидация хэндла папки расширения --------

async function ensurePermission(handle, mode) {
  if (!handle || !handle.queryPermission) return false;
  const opts = { mode: mode || 'readwrite' };
  let p = await handle.queryPermission(opts);
  if (p === 'granted') return true;
  p = await handle.requestPermission(opts);
  return p === 'granted';
}

async function readHandleManifest(handle) {
  const fileHandle = await handle.getFileHandle('manifest.json');
  const file = await fileHandle.getFile();
  const text = await file.text();
  return JSON.parse(text);
}

async function pickExtensionDir() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  // Валидация: папка должна содержать manifest.json с тем же name, что у нас.
  let mf;
  try {
    mf = await readHandleManifest(handle);
  } catch (e) {
    throw new Error('В выбранной папке нет manifest.json. Выберите ту самую папку, из которой вы загрузили расширение в chrome://extensions.');
  }
  const expectedName = chrome.runtime.getManifest().name;
  if (!mf || mf.name !== expectedName) {
    throw new Error('Это другая папка: в её manifest.json лежит "' + (mf && mf.name) + '". Нужна папка расширения «' + expectedName + '».');
  }
  await idbPut(IDB_KEY, handle);
  return handle;
}

async function getOrPickHandle() {
  let handle = null;
  try {
    handle = await idbGet(IDB_KEY);
  } catch (e) {
    handle = null;
  }
  if (!handle) return null;
  // Проверим, что хэндл всё ещё указывает на живую папку.
  try {
    await ensurePermission(handle, 'read');
    await readHandleManifest(handle);
    return handle;
  } catch (e) {
    return null;
  }
}

// -------- Скачивание + распаковка --------

async function downloadZip(onProgress) {
  const resp = await fetch(ZIP_URL, { cache: 'no-store' });
  if (!resp.ok) throw new Error('Не удалось скачать архив (HTTP ' + resp.status + ').');
  const total = parseInt(resp.headers.get('Content-Length') || '0', 10);
  if (!resp.body || !resp.body.getReader) {
    return new Uint8Array(await resp.arrayBuffer());
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function unzipAsync(buffer) {
  return new Promise((resolve, reject) => {
    if (!self.fflate || !self.fflate.unzip) {
      reject(new Error('fflate не загружен.'));
      return;
    }
    self.fflate.unzip(buffer, (err, files) => {
      if (err) reject(err);
      else resolve(files);
    });
  });
}

// -------- Запись файлов в папку расширения --------

async function getOrCreateDir(rootHandle, segments) {
  let cur = rootHandle;
  for (const seg of segments) {
    if (!seg) continue;
    cur = await cur.getDirectoryHandle(seg, { create: true });
  }
  return cur;
}

async function writeFile(rootHandle, relPath, data) {
  const parts = relPath.split('/').filter(Boolean);
  if (!parts.length) return;
  const fileName = parts.pop();
  const dir = await getOrCreateDir(rootHandle, parts);
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

// Из полного пути в zipball'е (например, "motlich1998-dotcom-F5----abc1234/F5 Расшифровка.../manifest.json")
// возвращает путь относительно папки расширения, либо null если файл вне неё.
function relPathInsideExtension(fullPath) {
  // Первый сегмент — имя верхней папки в архиве, всегда "<owner>-<repo>-<sha>".
  const parts = fullPath.split('/');
  if (parts.length < 2) return null;
  const rest = parts.slice(1).join('/');
  const prefix = EXT_FOLDER_NAME + '/';
  if (!rest.startsWith(prefix)) return null;
  const inside = rest.slice(prefix.length);
  if (!inside) return null;
  return inside;
}

// -------- Главный поток --------

async function runUpdate() {
  show(ui.progressCard);
  resetSteps();
  setBar(0);

  // Шаг 1: handle.
  setStep('check', 'active');
  setStatus('Проверяю папку расширения…');
  let handle = await getOrPickHandle();
  if (!handle) {
    setStep('check', null);
    show(ui.bindCard);
    return;
  }
  setStep('check', 'done');

  // Шаг 2: permission.
  setStep('permission', 'active');
  setStatus('Запрашиваю разрешение на запись…');
  const ok = await ensurePermission(handle, 'readwrite');
  if (!ok) {
    setStep('permission', 'error');
    showError('Без разрешения на запись расширение не сможет обновить файлы. Нажмите «Разрешить» в полоске Chrome и повторите.');
    return;
  }
  setStep('permission', 'done');
  setBar(15);

  // Шаг 3: download.
  setStep('download', 'active');
  setStatus('Скачиваю архив с GitHub…');
  let zipBytes;
  try {
    zipBytes = await downloadZip((received, total) => {
      const mb = (received / 1024 / 1024).toFixed(2);
      if (total > 0) {
        const pct = Math.round((received / total) * 100);
        setStatus('Скачиваю архив: ' + mb + ' МБ (' + pct + '%)');
        setBar(15 + (pct * 0.45));
      } else {
        setStatus('Скачиваю архив: ' + mb + ' МБ');
      }
    });
  } catch (e) {
    setStep('download', 'error');
    showError('Не удалось скачать архив: ' + (e && e.message ? e.message : String(e)));
    return;
  }
  setStep('download', 'done');
  setBar(60);

  // Шаг 4: unzip.
  setStep('unzip', 'active');
  setStatus('Распаковываю архив…');
  let files;
  try {
    files = await unzipAsync(zipBytes);
  } catch (e) {
    setStep('unzip', 'error');
    showError('Не удалось распаковать архив: ' + (e && e.message ? e.message : String(e)));
    return;
  }
  // Отбираем только файлы из папки расширения.
  const targets = [];
  for (const fullPath in files) {
    if (!Object.prototype.hasOwnProperty.call(files, fullPath)) continue;
    if (fullPath.endsWith('/')) continue; // директория-маркер, пропускаем
    const rel = relPathInsideExtension(fullPath);
    if (!rel) continue;
    targets.push({ rel: rel, data: files[fullPath] });
  }
  if (!targets.length) {
    setStep('unzip', 'error');
    showError('В архиве не нашлась папка «' + EXT_FOLDER_NAME + '». Возможно, она была переименована — обратитесь к разработчику.');
    return;
  }
  setStep('unzip', 'done');
  setBar(70);

  // Шаг 5: write files.
  setStep('write', 'active');
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    setStatus('Запись файлов: ' + (i + 1) + ' из ' + targets.length + ' — ' + t.rel);
    try {
      await writeFile(handle, t.rel, t.data);
    } catch (e) {
      setStep('write', 'error');
      showError('Не удалось записать файл «' + t.rel + '»: ' + (e && e.message ? e.message : String(e)));
      return;
    }
    setBar(70 + ((i + 1) / targets.length) * 25);
  }
  setStep('write', 'done');

  // Шаг 6: reload.
  setStep('reload', 'active');
  setStatus('Перезапуск расширения…');
  setBar(98);

  // Покажем «Готово» до самого reload — после reload эта страница тоже обновится.
  ui.doneText.textContent = 'Готово. Установлена версия ' + (await readVersionFromHandleSafe(handle)) + '.';
  show(ui.doneCard);

  setTimeout(() => {
    chrome.runtime.reload();
  }, 600);
}

async function readVersionFromHandleSafe(handle) {
  try {
    const mf = await readHandleManifest(handle);
    return mf && mf.version ? mf.version : '?';
  } catch (e) {
    return '?';
  }
}

// -------- Инициализация --------

async function init() {
  const currentVersion = chrome.runtime.getManifest().version;
  let availableVersion = '';

  // Из storage.local попробуем достать что у нас по последней проверке.
  try {
    const obj = await chrome.storage.local.get('update');
    if (obj && obj.update && obj.update.availableVersion) {
      availableVersion = obj.update.availableVersion;
    }
  } catch (e) {}

  // Если нет — спросим background сейчас.
  if (!availableVersion) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'F5VR_CHECK_UPDATES' });
      if (res && res.availableVersion) availableVersion = res.availableVersion;
    } catch (e) {}
  }

  fillVersions(currentVersion, availableVersion);

  // Если File System Access API недоступен — сразу в fallback.
  if (!('showDirectoryPicker' in window)) {
    showError(
      'Этот браузер не поддерживает автоматическое обновление расширений (File System Access API). '
      + 'Скачайте архив вручную по ссылке внизу окна и распакуйте поверх старой папки расширения.',
      { allowRebind: false }
    );
    return;
  }

  // Запускаем процесс — внутри сам решит, нужен ли picker.
  runUpdate();
}

// -------- События --------

ui.bindBtn.addEventListener('click', async () => {
  ui.bindBtn.disabled = true;
  try {
    await pickExtensionDir();
    runUpdate();
  } catch (e) {
    if (e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))) {
      // Пользователь сам закрыл диалог выбора — остаёмся на bindCard.
      return;
    }
    showError(e && e.message ? e.message : String(e));
  } finally {
    ui.bindBtn.disabled = false;
  }
});

ui.retryBtn.addEventListener('click', () => {
  show(ui.progressCard);
  runUpdate();
});

ui.rebindBtn.addEventListener('click', async () => {
  try {
    await idbDelete(IDB_KEY);
  } catch (e) {}
  show(ui.bindCard);
});

ui.manualBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: RELEASE_PAGE });
});

ui.manualLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: RELEASE_PAGE });
});

ui.closeBtn.addEventListener('click', () => {
  window.close();
});

document.addEventListener('DOMContentLoaded', init);
