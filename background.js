/**
 * F5 Variable Resolver — service worker.
 *
 * Единственная задача — периодически проверять, не появилась ли в репозитории
 * F5--- (ветка main) свежая версия расширения, и складывать результат в
 * chrome.storage.local. Сам процесс обновления (скачивание ZIP, распаковка,
 * запись в папку расширения, chrome.runtime.reload) живёт в окне update.html,
 * потому что File System Access API доступен только в window-контексте.
 *
 * Хранится:
 *   chrome.storage.local["update"] = {
 *     availableVersion: "2.1.9",
 *     currentVersion:   "2.1.9",
 *     checkedAt:        <ms>,
 *     hasUpdate:        true | false,
 *     error:            null | string
 *   }
 */

const ALARM_NAME = 'f5vr-update-check';
const CHECK_PERIOD_MINUTES = 12 * 60; // раз в 12 часов
const MANIFEST_URL = 'https://raw.githubusercontent.com/motlich1998-dotcom/F5---/main/manifest.json';

function parseVersion(v) {
  if (typeof v !== 'string') return [0, 0, 0];
  const parts = v.split('.').map((x) => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareVersions(a, b) {
  const aa = parseVersion(a);
  const bb = parseVersion(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] || 0;
    const y = bb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function checkForUpdates() {
  const currentVersion = chrome.runtime.getManifest().version;
  const checkedAt = Date.now();
  try {
    const resp = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const remote = await resp.json();
    const remoteVersion = String(remote.version || '');
    const hasUpdate = compareVersions(remoteVersion, currentVersion) > 0;
    await chrome.storage.local.set({
      update: {
        availableVersion: remoteVersion,
        currentVersion: currentVersion,
        checkedAt: checkedAt,
        hasUpdate: hasUpdate,
        error: null
      }
    });
    return { hasUpdate: hasUpdate, availableVersion: remoteVersion };
  } catch (e) {
    await chrome.storage.local.set({
      update: {
        availableVersion: '',
        currentVersion: currentVersion,
        checkedAt: checkedAt,
        hasUpdate: false,
        error: e && e.message ? e.message : String(e)
      }
    });
    return { hasUpdate: false, error: e };
  }
}

function isAllowedAppsScriptUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:'
      && (u.hostname === 'script.google.com' || u.hostname === 'script.googleusercontent.com');
  } catch (e) {
    return false;
  }
}

async function postAppsScriptWebApp(url, payload) {
  const body = JSON.stringify(payload || {});
  const targetUrl = String(url || '');
  if (!isAllowedAppsScriptUrl(targetUrl)) {
    throw new Error('URL должен указывать на Apps Script (https://script.google.com/…).');
  }

  async function readResponse(resp) {
    const text = await resp.text();
    return { resp: resp, text: text };
  }

  let result = await readResponse(await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body,
    redirect: 'follow',
    cache: 'no-store'
  }));

  if (/^\s*</.test(result.text)) {
    const manual = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      redirect: 'manual',
      cache: 'no-store'
    });
    const redirectUrl = manual.headers.get('Location');
    if (redirectUrl) {
      result = await readResponse(await fetch(redirectUrl, {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store'
      }));
    }
  }

  const text = result.text;
  if (/^\s*</.test(text)) {
    const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
    const extra = titleMatch ? (' (' + titleMatch[1] + ')') : '';
    throw new Error(
      'Сервер вернул HTML вместо JSON' + extra
      + '. Обновите код Apps Script и создайте новое развертывание веб-приложения.'
    );
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Сервер вернул некорректный ответ.');
  }
  if (!result.resp.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || ('HTTP ' + result.resp.status + ' при импорте.'));
  }
  return data;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: CHECK_PERIOD_MINUTES
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: CHECK_PERIOD_MINUTES
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) checkForUpdates();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'F5VR_CHECK_UPDATES') {
    checkForUpdates().then((res) => sendResponse(res));
    return true;
  }
  if (msg && msg.type === 'F5VR_SHEETS_DEPT_IMPORT') {
    postAppsScriptWebApp(msg.url, msg.payload)
      .then((res) => sendResponse(res))
      .catch((err) => {
        sendResponse({
          ok: false,
          error: err && err.message ? err.message : String(err)
        });
      });
    return true;
  }
});
