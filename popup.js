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

async function readStorage() {
  const raw = await chrome.storage.local.get([STORAGE_DICT_KEY, STORAGE_SETTINGS_KEY]);
  return {
    dict: raw[STORAGE_DICT_KEY] || {},
    settings: raw[STORAGE_SETTINGS_KEY] || { panelEnabled: true }
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
        files: ['lib/parser.js', 'lib/api.js', 'content.js']
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

async function refreshUi() {
  const tab = await getActiveTab();
  const host = tab ? hostnameFromUrl(tab.url || '') : '';
  $('#domain').textContent = host || '—';

  const { dict, settings } = await readStorage();
  const entry = dict[host];
  const total = entry && entry.fields ? Object.keys(entry.fields).length : 0;
  const counters = (entry && entry.counters) || { leads: 0, contacts: 0, companies: 0, catalogs: 0, pipelines: 0, statuses: 0 };
  $('#total').textContent = String(total);
  $('#updated').textContent = entry ? fmtDate(entry.fetchedAt) : '—';
  $('#cnt-leads').textContent = String(counters.leads || 0);
  $('#cnt-contacts').textContent = String(counters.contacts || 0);
  $('#cnt-companies').textContent = String(counters.companies || 0);
  $('#cnt-catalogs').textContent = String(counters.catalogs || 0);
  $('#cnt-pipelines').textContent = String(counters.pipelines || 0);
  $('#cnt-statuses').textContent = String(counters.statuses || 0);

  const panelEnabled = settings.panelEnabled !== false;
  $('#toggle').textContent = 'Панель: ' + (panelEnabled ? 'вкл' : 'выкл');

  const $refresh = $('#refresh');
  if (!isAmoHost(host)) {
    $refresh.disabled = true;
    $refresh.title = 'Откройте amoCRM/Kommo во вкладке';
  } else {
    $refresh.disabled = false;
    $refresh.title = '';
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

async function onOpenPanel() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) { setResult('Нет активной вкладки', 'is-err'); return; }
  const host = hostnameFromUrl(tab.url || '');
  if (!isAmoHost(host)) { setResult('Откройте amoCRM/Kommo в активной вкладке', 'is-err'); return; }
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
  $('#open-panel').addEventListener('click', onOpenPanel);
  refreshUi();
});
