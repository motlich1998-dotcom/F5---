/**
 * Коды доступа и доп. функции расширения F5.
 * window.F5VRExtras — чтение/запись chrome.storage.local, проверка кодов по SHA-256.
 * В исходниках нет plaintext-кодов, только хеши.
 */
(function (global) {
  'use strict';

  var STORAGE_EXTRAS_KEY = 'f5vr:extras';
  var FEATURE_CATDANCE = 'x7f3a';
  var FEATURE_MINESWEEPER = 'm9k2';
  var FEATURE_ENTITY_CALC = 'v1603';
  var FEATURE_SHEETS_EXPORT = 'sh03';
  var PROMO_SALT = 'f5vrpromo03';

  /** GIF по умолчанию (Tenor post 4265892713740262408). */
  var DEFAULT_CATDANCE_GIF_URL = 'https://media1.tenor.com/m/OzN-0kxqXAgAAAAC/cat.gif';

  /** Метаданные разблокируемых функций (id → UI). */
  var FEATURE_CATALOG = {
    x7f3a: {
      title: 'Cat Dance (Амма)',
      desc: 'Вместо текста подсказки Аммы — GIF. Можно указать свою ссылку (https). Работает, когда Амма не скрыта.'
    },
    m9k2: {
      title: 'Сапёр',
      desc: 'Кнопка 💣 в шторке F5 — сапёр в отдельном окне. Размер поля: 16×16, 32×32 или 64×64.'
    },
    v1603: {
      title: 'Формулы по сущности',
      desc: 'Тестовый режим: кнопка F5 в карточке amoCRM и расчёт шаблонов с :calc по текущей сущности.'
    },
    sh03: {
      title: 'Данные по разноске',
      desc: 'Кнопка на странице разноски: выводит таблицу в текстовом виде для копирования.'
    }
  };

  /** Хеш кода доступа → id функций. h = SHA-256(salt + UPPER(trim(code))). */
  var PROMO_ENTRIES = [
    { h: 'a8b4fc17f82add3bae2899f21d4a5bc5ee3c7d37557b7831b1af19344943f264', f: ['x7f3a'] },
    { h: '0a7d8f9712ec9224a8164087468a4ab2a47aa3cd78606ad99ebccb9015d1a2c1', f: ['m9k2'] },
    { h: '8342e5cc3ec8d316fee0834e021174372a57b35762f4518c3c0ff0cd7a667825', f: ['v1603'] },
    { h: 'a11fa454c172e2136a7ad0de9935b7b99f603925db5cd5b0e7b1f1c3e03047a8', f: ['sh03'] }
  ];

  function defaultExtras() {
    return { unlocked: [], enabled: {}, settings: {} };
  }

  function normalizePromoInput(code) {
    return String(code || '').trim().toUpperCase();
  }

  function hashPromo(code) {
    var normalized = normalizePromoInput(code);
    if (!normalized) return Promise.resolve('');
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.resolve('');
    }
    var data = new TextEncoder().encode(PROMO_SALT + normalized);
    return global.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }

  function readExtras() {
    return new Promise(function (resolve) {
      if (!global.chrome || !chrome.storage || !chrome.storage.local) {
        resolve(defaultExtras());
        return;
      }
      chrome.storage.local.get(STORAGE_EXTRAS_KEY, function (raw) {
        var base = defaultExtras();
        var stored = raw && raw[STORAGE_EXTRAS_KEY] ? raw[STORAGE_EXTRAS_KEY] : {};
        resolve({
          unlocked: Array.isArray(stored.unlocked) ? stored.unlocked.slice() : [],
          enabled: stored.enabled && typeof stored.enabled === 'object'
            ? Object.assign({}, stored.enabled)
            : {},
          settings: stored.settings && typeof stored.settings === 'object'
            ? Object.assign({}, stored.settings)
            : {}
        });
      });
    });
  }

  function writeExtras(extras) {
    return new Promise(function (resolve) {
      if (!global.chrome || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      var patch = {};
      patch[STORAGE_EXTRAS_KEY] = {
        unlocked: Array.isArray(extras.unlocked) ? extras.unlocked.slice() : [],
        enabled: extras.enabled && typeof extras.enabled === 'object'
          ? Object.assign({}, extras.enabled)
          : {},
        settings: extras.settings && typeof extras.settings === 'object'
          ? Object.assign({}, extras.settings)
          : {}
      };
      chrome.storage.local.set(patch, resolve);
    });
  }

  function featuresForHash(hash) {
    for (var i = 0; i < PROMO_ENTRIES.length; i++) {
      if (PROMO_ENTRIES[i].h === hash) return PROMO_ENTRIES[i].f.slice();
    }
    return [];
  }

  function mergeUnlock(extras, featureIds) {
    var next = {
      unlocked: extras.unlocked.slice(),
      enabled: Object.assign({}, extras.enabled),
      settings: extras.settings ? Object.assign({}, extras.settings) : {}
    };
    var added = [];
    for (var i = 0; i < featureIds.length; i++) {
      var id = featureIds[i];
      if (next.unlocked.indexOf(id) === -1) {
        next.unlocked.push(id);
        added.push(id);
      }
      if (next.enabled[id] === undefined) next.enabled[id] = true;
    }
    return { extras: next, added: added };
  }

  /**
   * @returns {Promise<{status:'ok'|'unknown'|'empty'|'already', features:string[], extras:object}>}
   */
  function redeemPromo(code) {
    var normalized = normalizePromoInput(code);
    if (!normalized) {
      return readExtras().then(function (extras) {
        return { status: 'empty', features: [], extras: extras };
      });
    }
    return hashPromo(code).then(function (hash) {
      var ids = featuresForHash(hash);
      if (!ids.length) {
        return readExtras().then(function (extras) {
          return { status: 'unknown', features: [], extras: extras };
        });
      }
      return readExtras().then(function (extras) {
        var allKnown = true;
        for (var i = 0; i < ids.length; i++) {
          if (extras.unlocked.indexOf(ids[i]) === -1) {
            allKnown = false;
            break;
          }
        }
        if (allKnown) {
          return { status: 'already', features: ids, extras: extras };
        }
        var merged = mergeUnlock(extras, ids);
        return writeExtras(merged.extras).then(function () {
          return {
            status: 'ok',
            features: merged.added.length ? merged.added : ids,
            extras: merged.extras
          };
        });
      });
    });
  }

  function setFeatureEnabled(featureId, enabled) {
    return readExtras().then(function (extras) {
      if (extras.unlocked.indexOf(featureId) === -1) return extras;
      var next = {
        unlocked: extras.unlocked.slice(),
        enabled: Object.assign({}, extras.enabled, { [featureId]: !!enabled }),
        settings: extras.settings ? Object.assign({}, extras.settings) : {}
      };
      return writeExtras(next).then(function () { return next; });
    });
  }

  function isFeatureUnlocked(featureId, extras) {
    return extras && Array.isArray(extras.unlocked) && extras.unlocked.indexOf(featureId) !== -1;
  }

  function isFeatureEnabled(featureId, extras) {
    if (!isFeatureUnlocked(featureId, extras)) return false;
    if (!extras.enabled || extras.enabled[featureId] === undefined) return true;
    return !!extras.enabled[featureId];
  }

  function listUnlockedFeatures(extras) {
    var out = [];
    if (!extras || !Array.isArray(extras.unlocked)) return out;
    for (var i = 0; i < extras.unlocked.length; i++) {
      var id = extras.unlocked[i];
      var meta = FEATURE_CATALOG[id] || { title: id, desc: '' };
      out.push({
        id: id,
        title: meta.title,
        desc: meta.desc,
        enabled: isFeatureEnabled(id, extras)
      });
    }
    return out;
  }

  function normalizeGifUrl(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    try {
      var u = new URL(s);
      if (u.protocol !== 'https:') return '';
      return u.href;
    } catch (e) {
      return '';
    }
  }

  function getCatDanceGifUrl(extras) {
    var st = extras && extras.settings && extras.settings[FEATURE_CATDANCE];
    var custom = normalizeGifUrl(st && st.gifUrl);
    return custom || DEFAULT_CATDANCE_GIF_URL;
  }

  function normalizeBoardSize(raw) {
    var s = String(raw || '').trim();
    if (s === '32' || s === '64') return s;
    return '16';
  }

  function getMinesweeperBoardSize(extras) {
    var st = extras && extras.settings && extras.settings[FEATURE_MINESWEEPER];
    return normalizeBoardSize(st && st.boardSize);
  }

  function getMinesweeperOptions(extras) {
    var key = getMinesweeperBoardSize(extras);
    if (global.F5VRMinesweeper && global.F5VRMinesweeper.presetOptions) {
      return global.F5VRMinesweeper.presetOptions(key);
    }
    return { preset: key, boardSize: key, rows: 16, cols: 16, mines: 40 };
  }

  function normalizeSheetsEmployeeName(raw) {
    return String(raw || '').replace(/\s+/g, ' ').trim();
  }

  function getSheetsEmployeeName(extras) {
    var st = extras && extras.settings && extras.settings[FEATURE_SHEETS_EXPORT];
    return normalizeSheetsEmployeeName(st && st.employeeName);
  }

  function setFeatureSetting(featureId, key, value) {
    return readExtras().then(function (extras) {
      if (extras.unlocked.indexOf(featureId) === -1) return extras;
      var settings = Object.assign({}, extras.settings || {});
      var featSettings = Object.assign({}, settings[featureId] || {});
      featSettings[key] = value;
      settings[featureId] = featSettings;
      var next = {
        unlocked: extras.unlocked.slice(),
        enabled: Object.assign({}, extras.enabled),
        settings: settings
      };
      return writeExtras(next).then(function () { return next; });
    });
  }

  /** Точка расширения: поведение доп. функций на странице amoCRM. */
  function applyEnabledFeatures(extras, hooks) {
    hooks = hooks || {};
    if (isFeatureEnabled(FEATURE_CATDANCE, extras) && typeof hooks.onCatDance === 'function') {
      hooks.onCatDance(true);
    } else if (typeof hooks.onCatDance === 'function') {
      hooks.onCatDance(false);
    }
    if (isFeatureEnabled(FEATURE_MINESWEEPER, extras) && typeof hooks.onMinesweeper === 'function') {
      hooks.onMinesweeper(true);
    } else if (typeof hooks.onMinesweeper === 'function') {
      hooks.onMinesweeper(false);
    }
    if (isFeatureEnabled(FEATURE_ENTITY_CALC, extras) && typeof hooks.onEntityCalc === 'function') {
      hooks.onEntityCalc(true);
    } else if (typeof hooks.onEntityCalc === 'function') {
      hooks.onEntityCalc(false);
    }
    if (isFeatureEnabled(FEATURE_SHEETS_EXPORT, extras) && typeof hooks.onSheetsExport === 'function') {
      hooks.onSheetsExport(true);
    } else if (typeof hooks.onSheetsExport === 'function') {
      hooks.onSheetsExport(false);
    }
  }

  global.F5VRExtras = {
    STORAGE_EXTRAS_KEY: STORAGE_EXTRAS_KEY,
    FEATURE_CATDANCE: FEATURE_CATDANCE,
    FEATURE_MINESWEEPER: FEATURE_MINESWEEPER,
    FEATURE_ENTITY_CALC: FEATURE_ENTITY_CALC,
    FEATURE_SHEETS_EXPORT: FEATURE_SHEETS_EXPORT,
    DEFAULT_CATDANCE_GIF_URL: DEFAULT_CATDANCE_GIF_URL,
    readExtras: readExtras,
    redeemPromo: redeemPromo,
    setFeatureEnabled: setFeatureEnabled,
    setFeatureSetting: setFeatureSetting,
    isFeatureEnabled: isFeatureEnabled,
    listUnlockedFeatures: listUnlockedFeatures,
    getCatDanceGifUrl: getCatDanceGifUrl,
    getMinesweeperBoardSize: getMinesweeperBoardSize,
    getMinesweeperOptions: getMinesweeperOptions,
    normalizeBoardSize: normalizeBoardSize,
    normalizeSheetsEmployeeName: normalizeSheetsEmployeeName,
    getSheetsEmployeeName: getSheetsEmployeeName,
    normalizeGifUrl: normalizeGifUrl,
    applyEnabledFeatures: applyEnabledFeatures
  };
})(typeof window !== 'undefined' ? window : self);
