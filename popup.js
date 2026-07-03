'use strict';

const STORAGE_DICT_KEY = 'f5vr:dict';
const STORAGE_SETTINGS_KEY = 'f5vr:settings';

const $ = (sel) => document.querySelector(sel);

function fmtDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('ru-RU', { hour12: false });
  } catch (e) { return '—'; }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

function hostnameFromUrl(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function isAmoHost(host) {
  return /\.amocrm\.(ru|com)$/i.test(host || '') || /\.kommo\.com$/i.test(host || '');
}

function isSheetsHost(host) {
  return (host || '').toLowerCase() === '147.45.164.13';
}

function isSupportedHost(host) {
  return isAmoHost(host) || isSheetsHost(host);
}

async function readStorage() {
  const raw = await chrome.storage.local.get([STORAGE_DICT_KEY, STORAGE_SETTINGS_KEY]);
  return {
    dict: raw[STORAGE_DICT_KEY] || {},
    settings: raw[STORAGE_SETTINGS_KEY] || { panelEnabled: true, hideAmma: false }
  };
}

async function writeSettings(settings) {
  const patch = {};
  patch[STORAGE_SETTINGS_KEY] = settings;
  await chrome.storage.local.set(patch);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'F5VR_PING' });
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['lib/parser.js', 'lib/api.js', 'lib/extras.js', 'lib/minesweeper.js', 'content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content.css']
      });
      return true;
    } catch (err) {
      return false;
    }
  }
}

function setResult(msg, kind, errors) {
  const el = $('#result');
  el.classList.remove('is-ok', 'is-err', 'is-progress');
  let html = msg ? msg : '';
  if (errors && errors.length) {
    html += '<div class="errs">';
    errors.slice(0, 4).forEach((e) => {
      html += '<div>· ' + (e.scope || '') + ': ' + (e.status ? 'HTTP ' + e.status : '') + ' ' + (e.message || '') + '</div>';
    });
    html += '</div>';
  }
  el.innerHTML = html;
  if (kind) el.classList.add(kind);
}

function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function syncUpdateBanner() {
  const banner = $('#update-banner');
  if (!banner) return;
  const currentVersion = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  let stored = null;
  try {
    const obj = await chrome.storage.local.get('update');
    stored = obj && obj.update ? obj.update : null;
  } catch (e) {}
  if (!stored || !stored.availableVersion) {
    banner.hidden = true;
    return;
  }
  const newer = compareVersions(stored.availableVersion, currentVersion) > 0;
  if (!newer) {
    banner.hidden = true;
    return;
  }
  $('#ub-ver').textContent = 'v' + stored.availableVersion;
  $('#ub-sub').textContent = 'установлена v' + currentVersion;
  banner.hidden = false;
}

function openUpdateWindow() {
  const url = chrome.runtime.getURL('update.html');
  chrome.windows.create({ url: url, type: 'popup', width: 480, height: 460 });
  window.close();
}

let checkBusy = false;
async function onCheckUpdates(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (checkBusy) return;
  checkBusy = true;
  const state = $('#check-state');
  if (state) state.textContent = 'проверяю…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'F5VR_CHECK_UPDATES' });
    await syncUpdateBanner();
    if (state) {
      if (res && res.error) state.textContent = 'ошибка проверки';
      else if (res && res.hasUpdate) state.textContent = 'доступно ' + res.availableVersion;
      else state.textContent = 'актуальная';
    }
  } catch (err) {
    if (state) state.textContent = 'ошибка';
  } finally {
    checkBusy = false;
    setTimeout(() => { if (state) state.textContent = ''; }, 4000);
  }
}

async function notifyExtrasChanged(tab) {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'F5VR_EXTRAS_CHANGED' });
  } catch (e) { /* noop */ }
}

function showView(name) {
  const main = $('#view-main');
  const extras = $('#view-extras');
  const chromeBlocks = ['#hint', '.stats', '.counters', '#update-banner'];
  if (!main || !extras) return;
  if (name === 'extras') {
    main.hidden = true;
    extras.hidden = false;
    chromeBlocks.forEach((sel) => {
      const el = $(sel);
      if (el) el.hidden = true;
    });
  } else {
    main.hidden = false;
    extras.hidden = true;
    chromeBlocks.forEach((sel) => {
      const el = $(sel);
      if (el && sel !== '#update-banner') el.hidden = false;
    });
    syncUpdateBanner();
  }
}

function setExtrasMsg(text, kind) {
  const el = $('#extras-msg');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.remove('is-ok', 'is-err', 'is-info');
  if (kind) el.classList.add(kind);
}

async function renderExtrasList() {
  const listEl = $('#extras-list');
  const emptyEl = $('#extras-empty');
  if (!listEl || !window.F5VRExtras) return;
  const extras = await window.F5VRExtras.readExtras();
  const items = window.F5VRExtras.listUnlockedFeatures(extras);
  const catId = window.F5VRExtras.FEATURE_CATDANCE || 'x7f3a';
  const msId = window.F5VRExtras.FEATURE_MINESWEEPER || 'm9k2';
  const sheetsId = window.F5VRExtras.FEATURE_SHEETS_EXPORT || 'sh03';
  const savedGif = (extras.settings && extras.settings[catId] && extras.settings[catId].gifUrl) || '';
  const savedBoard = window.F5VRExtras.getMinesweeperBoardSize
    ? window.F5VRExtras.getMinesweeperBoardSize(extras)
    : '16';
  const savedSheetsEmployee = window.F5VRExtras.getSheetsEmployeeName
    ? window.F5VRExtras.getSheetsEmployeeName(extras)
    : ((extras.settings && extras.settings[sheetsId] && extras.settings[sheetsId].employeeName) || '');
  const savedDeptImport = window.F5VRExtras.getSheetsDeptImportSettings
    ? window.F5VRExtras.getSheetsDeptImportSettings(extras)
    : { importUrl: '', importSecret: '', sheetTab: '' };
  listEl.innerHTML = '';
  if (emptyEl) emptyEl.hidden = items.length > 0;
  items.forEach((it) => {
    const block = document.createElement('div');
    block.className = 'extras-item-block';

    const row = document.createElement('label');
    row.className = 'extras-item';
    row.innerHTML = ''
      + '<input type="checkbox" class="extras-toggle" data-feature-id="' + it.id + '"'
      + (it.enabled ? ' checked' : '') + ' />'
      + '<div class="extras-item-label">'
      +   '<div class="extras-item-title">' + escapeHtml(it.title) + '</div>'
      +   (it.desc ? '<div class="extras-item-desc">' + escapeHtml(it.desc) + '</div>' : '')
      + '</div>';
    block.appendChild(row);

    if (it.id === catId) {
      const settings = document.createElement('div');
      settings.className = 'extras-feature-settings';
      settings.innerHTML = ''
        + '<div class="extras-settings-label">Ссылка на GIF (https)</div>'
        + '<div class="extras-gif-row">'
        +   '<input type="url" class="extras-gif-input" id="catdance-gif-url" '
        +   'placeholder="https://…/file.gif" spellcheck="false" autocomplete="off" '
        +   'value="' + escapeHtml(savedGif) + '" />'
        +   '<button type="button" class="btn" id="catdance-gif-save">Сохранить</button>'
        + '</div>'
        + '<div class="extras-settings-hint">Прямая ссылка на файл (.gif, .webp, .png). '
        + 'Пустое поле — GIF по умолчанию (кот).</div>';
      block.appendChild(settings);
    }

    if (it.id === msId) {
      const settings = document.createElement('div');
      settings.className = 'extras-feature-settings';
      settings.innerHTML = ''
        + '<div class="extras-settings-label">Размер поля</div>'
        + '<div class="extras-gif-row">'
        +   '<select class="extras-ms-size" id="ms-board-size">'
        +     '<option value="16"' + (savedBoard === '16' ? ' selected' : '') + '>16×16 (40 мин)</option>'
        +     '<option value="32"' + (savedBoard === '32' ? ' selected' : '') + '>32×32 (160 мин)</option>'
        +     '<option value="64"' + (savedBoard === '64' ? ' selected' : '') + '>64×64 (640 мин)</option>'
        +   '</select>'
        +   '<button type="button" class="btn" id="ms-board-save">Сохранить</button>'
        + '</div>';
      block.appendChild(settings);
    }

    if (it.id === sheetsId) {
      const settings = document.createElement('div');
      settings.className = 'extras-feature-settings';
      settings.innerHTML = ''
        + '<div class="extras-settings-label">Сотрудник по умолчанию</div>'
        + '<div class="extras-gif-row">'
        +   '<input type="text" class="extras-gif-input" id="sheets-employee-name" '
        +   'placeholder="Фамилия Имя" spellcheck="false" autocomplete="off" '
        +   'value="' + escapeHtml(savedSheetsEmployee) + '" />'
        +   '<button type="button" class="btn" id="sheets-employee-save">Сохранить</button>'
        + '</div>'
        + '<div class="extras-settings-hint">Если сотрудник найден в разноске, выбор при клике пропускается.</div>'
        + '<div class="extras-settings-label">Импорт отдела в Google Sheet</div>'
        + '<div class="extras-gif-row">'
        +   '<input type="url" class="extras-gif-input" id="dept-import-url" '
        +   'placeholder="https://script.google.com/macros/s/…/exec" spellcheck="false" autocomplete="off" '
        +   'value="' + escapeHtml(savedDeptImport.importUrl || '') + '" />'
        + '</div>'
        + '<div class="extras-settings-label">Секретный токен</div>'
        + '<div class="extras-gif-row">'
        +   '<input type="password" class="extras-gif-input" id="dept-import-secret" '
        +   'placeholder="любая длинная строка" spellcheck="false" autocomplete="off" '
        +   'value="' + escapeHtml(savedDeptImport.importSecret || '') + '" />'
        + '</div>'
        + '<div class="extras-settings-label">Имя листа (необязательно)</div>'
        + '<div class="extras-gif-row">'
        +   '<input type="text" class="extras-gif-input" id="dept-import-tab" '
        +   'placeholder="Разноска" spellcheck="false" autocomplete="off" '
        +   'value="' + escapeHtml(savedDeptImport.sheetTab || '') + '" />'
        +   '<button type="button" class="btn" id="dept-import-save">Сохранить</button>'
        + '</div>'
        + '<div class="extras-settings-hint">Скрипт для таблицы: private/sheets-dept-import.gs</div>';
      block.appendChild(settings);
    }

    listEl.appendChild(block);
  });
}

async function onMsBoardSave() {
  if (!window.F5VRExtras) return;
  const sel = $('#ms-board-size');
  const msId = window.F5VRExtras.FEATURE_MINESWEEPER || 'm9k2';
  const size = window.F5VRExtras.normalizeBoardSize
    ? window.F5VRExtras.normalizeBoardSize(sel ? sel.value : '16')
    : '16';
  await window.F5VRExtras.setFeatureSetting(msId, 'boardSize', size);
  setExtrasMsg('Размер поля сохранён.', 'is-ok');
  const tab = await getActiveTab();
  await notifyExtrasChanged(tab);
}

async function onSheetsEmployeeSave() {
  if (!window.F5VRExtras) return;
  const input = $('#sheets-employee-name');
  const sheetsId = window.F5VRExtras.FEATURE_SHEETS_EXPORT || 'sh03';
  const raw = input ? input.value : '';
  const normalized = window.F5VRExtras.normalizeSheetsEmployeeName
    ? window.F5VRExtras.normalizeSheetsEmployeeName(raw)
    : String(raw || '').replace(/\s+/g, ' ').trim();
  await window.F5VRExtras.setFeatureSetting(sheetsId, 'employeeName', normalized);
  if (input) input.value = normalized;
  setExtrasMsg(normalized ? 'Сотрудник сохранён.' : 'Сотрудник по умолчанию очищен.', 'is-ok');
  const tab = await getActiveTab();
  await notifyExtrasChanged(tab);
}

async function onDeptImportSave() {
  if (!window.F5VRExtras) return;
  const sheetsId = window.F5VRExtras.FEATURE_SHEETS_EXPORT || 'sh03';
  const urlInput = $('#dept-import-url');
  const secretInput = $('#dept-import-secret');
  const tabInput = $('#dept-import-tab');
  const importUrl = urlInput ? String(urlInput.value || '').trim() : '';
  const importSecret = secretInput ? String(secretInput.value || '').trim() : '';
  const sheetTab = tabInput ? String(tabInput.value || '').trim() : '';
  if (importUrl && !/^https:\/\//i.test(importUrl)) {
    setExtrasMsg('URL должен начинаться с https://', 'is-err');
    return;
  }
  await window.F5VRExtras.setFeatureSetting(sheetsId, 'importUrl', importUrl);
  await window.F5VRExtras.setFeatureSetting(sheetsId, 'importSecret', importSecret);
  await window.F5VRExtras.setFeatureSetting(sheetsId, 'sheetTab', sheetTab);
  setExtrasMsg('Настройки импорта сохранены.', 'is-ok');
  const tab = await getActiveTab();
  await notifyExtrasChanged(tab);
}

async function onCatDanceGifSave() {
  if (!window.F5VRExtras) return;
  const input = $('#catdance-gif-url');
  const raw = input ? input.value : '';
  const catId = window.F5VRExtras.FEATURE_CATDANCE || 'x7f3a';
  const normalized = window.F5VRExtras.normalizeGifUrl(raw);
  if (raw.trim() && !normalized) {
    setExtrasMsg('Нужна прямая https-ссылка на изображение.', 'is-err');
    return;
  }
  await window.F5VRExtras.setFeatureSetting(catId, 'gifUrl', normalized);
  if (input && !normalized) input.value = '';
  setExtrasMsg(normalized ? 'GIF сохранена.' : 'Сброшено на GIF по умолчанию.', 'is-ok');
  const tab = await getActiveTab();
  await notifyExtrasChanged(tab);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function onOpenExtras() {
  showView('extras');
  setExtrasMsg('', '');
  const input = $('#promo-input');
  if (input) { input.value = ''; input.focus(); }
  await renderExtrasList();
}

function onExtrasBack() {
  showView('main');
  setExtrasMsg('', '');
  refreshUi();
}

let promoBusy = false;
async function onPromoApply() {
  if (promoBusy || !window.F5VRExtras) return;
  promoBusy = true;
  const btn = $('#promo-apply');
  if (btn) btn.disabled = true;
  try {
    const input = $('#promo-input');
    const code = input ? input.value : '';
    const res = await window.F5VRExtras.redeemPromo(code);
    if (res.status === 'empty') {
      setExtrasMsg('Введите код доступа.', 'is-err');
    } else if (res.status === 'unknown') {
      setExtrasMsg('Код не найден.', 'is-err');
    } else if (res.status === 'already') {
      setExtrasMsg('Эти функции уже разблокированы.', 'is-info');
    } else if (res.status === 'ok') {
      setExtrasMsg('Разблокировано! Новые функции добавлены в список ниже.', 'is-ok');
      if (input) input.value = '';
    }
    await renderExtrasList();
    await refreshUi();
    const tab = await getActiveTab();
    await notifyExtrasChanged(tab);
  } finally {
    promoBusy = false;
    if (btn) btn.disabled = false;
  }
}

async function onExtrasToggleChange(e) {
  const t = e.target;
  if (!t || !t.classList || !t.classList.contains('extras-toggle')) return;
  const id = t.getAttribute('data-feature-id');
  if (!id || !window.F5VRExtras) return;
  await window.F5VRExtras.setFeatureEnabled(id, t.checked);
  const tab = await getActiveTab();
  await notifyExtrasChanged(tab);
}

async function refreshUi() {
  const tab = await getActiveTab();
  const host = tab ? hostnameFromUrl(tab.url || '') : '';
  $('#domain').textContent = host || '—';

  const { dict, settings } = await readStorage();
  const entry = dict[host];
  const total = entry && entry.fields ? Object.keys(entry.fields).length : 0;
  const counters = (entry && entry.counters) || { leads: 0, contacts: 0, companies: 0, catalogs: 0, pipelines: 0, statuses: 0, users: 0, userGroups: 0 };
  $('#total').textContent = String(total);
  $('#updated').textContent = entry ? fmtDate(entry.fetchedAt) : '—';
  $('#cnt-leads').textContent = String(counters.leads || 0);
  $('#cnt-contacts').textContent = String(counters.contacts || 0);
  $('#cnt-companies').textContent = String(counters.companies || 0);
  $('#cnt-catalogs').textContent = String(counters.catalogs || 0);
  $('#cnt-pipelines').textContent = String(counters.pipelines || 0);
  $('#cnt-statuses').textContent = String(counters.statuses || 0);
  $('#cnt-users').textContent = String(counters.users || 0);
  $('#cnt-userGroups').textContent = String(counters.userGroups || 0);

  const panelEnabled = settings.panelEnabled !== false;
  $('#toggle').textContent = 'Панель: ' + (panelEnabled ? 'вкл' : 'выкл');
  const hideAmma = !!settings.hideAmma;
  $('#toggle-amma').textContent = 'Амма: ' + (hideAmma ? 'скрыта' : 'показана');
  $('#toggle-amma').title = hideAmma
    ? 'Нажмите, чтобы вернуть кнопку Аммы и её подсказки на странице amoCRM'
    : 'Нажмите, чтобы скрыть кнопку Аммы и её подсказки («С этой сделкой что-то не так…») на страницах amoCRM';

  const $refresh = $('#refresh');
  if (!isAmoHost(host)) {
    $refresh.disabled = true;
    $refresh.title = 'Откройте amoCRM/Kommo во вкладке';
  } else {
    $refresh.disabled = false;
    $refresh.title = '';
  }

  const $openPanel = $('#open-panel');
  if ($openPanel) {
    if (!isSupportedHost(host)) {
      $openPanel.disabled = true;
      $openPanel.title = 'Откройте amoCRM/Kommo или страницу разноски';
    } else {
      $openPanel.disabled = false;
      $openPanel.title = '';
    }
  }

  const $domains = $('#domains');
  $domains.innerHTML = '';
  const hosts = Object.keys(dict).sort();
  if (!hosts.length) {
    $domains.innerHTML = '<div class="dr-cnt" style="padding:6px;">Пока нет сохранённых доменов</div>';
  } else {
    hosts.forEach((h) => {
      const cnt = dict[h] && dict[h].fields ? Object.keys(dict[h].fields).length : 0;
      const row = document.createElement('div');
      row.className = 'domain-row';
      row.innerHTML = `<div class="dr-name" title="${h}">${h}</div><div class="dr-cnt">${cnt}</div>`;
      $domains.appendChild(row);
    });
  }
}

function bindProgressListener() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'F5VR_PROGRESS') return;
    setResult(msg.message || 'Загрузка…', 'is-progress');
  });
}

async function onRefresh() {
  setResult('Загружаю словарь…', 'is-progress');
  const tab = await getActiveTab();
  if (!tab || !tab.id) { setResult('Нет активной вкладки', 'is-err'); return; }
  const host = hostnameFromUrl(tab.url || '');
  if (!isAmoHost(host)) { setResult('Откройте amoCRM/Kommo в активной вкладке', 'is-err'); return; }

  const ok = await ensureContentScript(tab.id);
  if (!ok) { setResult('Не удалось внедрить скрипт. Перезагрузите вкладку.', 'is-err'); return; }

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: 'F5VR_REFRESH' });
  } catch (e) {
    setResult('Страница не отвечает. Перезагрузите вкладку.', 'is-err');
    return;
  }
  if (!resp || !resp.ok) {
    if (resp && resp.error === 'unauthorized') {
      setResult('Не авторизованы в амо. Войдите в аккаунт и попробуйте снова.', 'is-err', resp.errors);
    } else if (resp && resp.error === 'already_running') {
      setResult('Уже идёт обновление…', 'is-progress');
    } else {
      setResult('Не удалось обновить словарь.', 'is-err', resp && resp.errors);
    }
    return;
  }
  const partial = resp.errors && resp.errors.length ? ' (частично, см. ниже)' : '';
  setResult('Готово: ' + resp.total + ' полей' + partial, 'is-ok', resp.errors);
  await refreshUi();
}

async function onClear() {
  const tab = await getActiveTab();
  const host = tab ? hostnameFromUrl(tab.url || '') : '';
  if (!host) return;
  if (tab && tab.id) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'F5VR_CLEAR_HOST' }); } catch (e) {}
  } else {
    const { dict } = await readStorage();
    if (dict[host]) {
      delete dict[host];
      const patch = {}; patch[STORAGE_DICT_KEY] = dict;
      await chrome.storage.local.set(patch);
    }
  }
  setResult('Словарь домена очищен.', 'is-ok');
  await refreshUi();
}

let toggleBusy = false;
async function onToggle() {
  if (toggleBusy) return;
  toggleBusy = true;
  const $btn = $('#toggle');
  $btn.disabled = true;
  try {
    const { settings } = await readStorage();
    const cur = settings.panelEnabled !== false;
    const next = Object.assign({}, settings, { panelEnabled: !cur });
    await writeSettings(next);
    await refreshUi();
    const tab = await getActiveTab();
    if (tab && tab.id) {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'F5VR_TOGGLE_PANEL_ENABLED', enabled: next.panelEnabled }); } catch (e) {}
    }
  } finally {
    toggleBusy = false;
    $btn.disabled = false;
  }
}

let toggleAmmaBusy = false;
async function onToggleAmma() {
  if (toggleAmmaBusy) return;
  toggleAmmaBusy = true;
  const $btn = $('#toggle-amma');
  $btn.disabled = true;
  try {
    const { settings } = await readStorage();
    const cur = !!settings.hideAmma;
    const next = Object.assign({}, settings, { hideAmma: !cur });
    await writeSettings(next);
    await refreshUi();
    const tab = await getActiveTab();
    if (tab && tab.id && isAmoHost(hostnameFromUrl(tab.url || ''))) {
      try {
        await ensureContentScript(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: 'F5VR_TOGGLE_AMMA_HIDDEN', hidden: next.hideAmma });
      } catch (e) { /* noop */ }
    }
    if (cur) {
      // Убираем скрытие — Амма должна сразу появиться, перезагрузка не нужна.
      setResult('Амма возвращена (кнопка и подсказки).', 'is-ok');
    } else {
      setResult('Амма скрыта на amoCRM-страницах (кнопка и подсказки).', 'is-ok');
    }
  } finally {
    toggleAmmaBusy = false;
    $btn.disabled = false;
  }
}

async function onOpenPanel() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) { setResult('Нет активной вкладки', 'is-err'); return; }
  const host = hostnameFromUrl(tab.url || '');
  if (!isSupportedHost(host)) { setResult('Откройте amoCRM/Kommo или страницу разноски в активной вкладке', 'is-err'); return; }
  const ok = await ensureContentScript(tab.id);
  if (!ok) { setResult('Не удалось внедрить скрипт. Перезагрузите вкладку.', 'is-err'); return; }
  // Если панель ранее была отключена — включим её в настройках, иначе mountPanel выйдет раньше времени.
  const { settings } = await readStorage();
  if (settings.panelEnabled === false) {
    await writeSettings(Object.assign({}, settings, { panelEnabled: true }));
    try { await chrome.tabs.sendMessage(tab.id, { type: 'F5VR_TOGGLE_PANEL_ENABLED', enabled: true }); } catch (e) {}
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'F5VR_OPEN_PANEL' });
    window.close();
  } catch (e) {
    setResult('Страница не отвечает. Перезагрузите вкладку.', 'is-err');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    const v = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
    if (v) {
      const verEl = $('#ver'); if (verEl) verEl.textContent = 'v' + v;
      const verFootEl = $('#ver-foot'); if (verFootEl) verFootEl.textContent = v;
    }
  } catch (_) { /* noop */ }
  bindProgressListener();
  $('#refresh').addEventListener('click', onRefresh);
  $('#clear').addEventListener('click', onClear);
  $('#toggle').addEventListener('click', onToggle);
  $('#toggle-amma').addEventListener('click', onToggleAmma);
  $('#open-panel').addEventListener('click', onOpenPanel);
  $('#open-extras').addEventListener('click', onOpenExtras);
  $('#extras-back').addEventListener('click', onExtrasBack);
  $('#promo-apply').addEventListener('click', onPromoApply);
  const promoInput = $('#promo-input');
  if (promoInput) {
    promoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onPromoApply(); }
    });
  }
  const extrasList = $('#extras-list');
  if (extrasList) {
    extrasList.addEventListener('change', onExtrasToggleChange);
    extrasList.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.id === 'catdance-gif-save') {
        e.preventDefault();
        onCatDanceGifSave();
      }
      if (t && t.id === 'ms-board-save') {
        e.preventDefault();
        onMsBoardSave();
      }
      if (t && t.id === 'sheets-employee-save') {
        e.preventDefault();
        onSheetsEmployeeSave();
      }
      if (t && t.id === 'dept-import-save') {
        e.preventDefault();
        onDeptImportSave();
      }
    });
    extrasList.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.id === 'catdance-gif-url') {
        e.preventDefault();
        onCatDanceGifSave();
      }
      if (e.key === 'Enter' && e.target && e.target.id === 'sheets-employee-name') {
        e.preventDefault();
        onSheetsEmployeeSave();
      }
    });
  }
  const ubBtn = $('#ub-update'); if (ubBtn) ubBtn.addEventListener('click', openUpdateWindow);
  const checkLink = $('#check-updates'); if (checkLink) checkLink.addEventListener('click', onCheckUpdates);
  refreshUi();
  syncUpdateBanner();
});
