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
 *     availableVersion: "2.1.7",
 *     currentVersion:   "2.1.7",
 *     checkedAt:        <ms>,
 *     hasUpdate:        true | false,
 *     error:            null | string
 *   }
 */

const ALARM_NAME = 'f5vr-update-check';
const CHECK_PERIOD_MINUTES = 12 * 60; // раз в 12 часов
// Файлы расширения лежат в корне репозитория F5---, без подпапки.
const MANIFEST_URL = 'https://raw.githubusercontent.com/motlich1998-dotcom/F5---/main/manifest.json';

function parseVersion(v) {
  if (typeof v !== 'string') return [0, 0, 0];
  const parts = v.split('.').map((x) => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

// Возвращает 1, 0 или -1 для (a > b, a == b, a < b).
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
    // cache: 'no-store' — раз в 12 часов точно хочется свежий ответ.
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

async function postAppsScriptWebApp(url, payload) {
  const body = JSON.stringify(payload || {});
  // Apps Script: POST выполняет doPost, затем 302 → GET на echo-URL с JSON-ответом.
  // redirect:'follow' в service worker сам делает GET; manual ломается (opaque redirect).
  const resp = await fetch(String(url || ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body,
    redirect: 'follow',
    cache: 'no-store'
  });
  const text = await resp.text();
  if (/^\s*</.test(text)) {
    throw new Error('Сервер вернул HTML вместо JSON. Проверьте URL и развертывание Apps Script.');
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Сервер вернул некорректный ответ.');
  }
  if (!resp.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || ('HTTP ' + resp.status + ' при импорте.'));
  }
  return data;
}

// Ручная проверка из попапа: { type: 'F5VR_CHECK_UPDATES' } -> { hasUpdate, availableVersion }
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
