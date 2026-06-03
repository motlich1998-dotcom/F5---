/**
 * Промокоды и доп. функции расширения F5.
 * window.F5VRExtras — чтение/запись chrome.storage.local, проверка кодов по SHA-256.
 * В исходниках нет plaintext-промокодов, только хеши.
 */
(function (global) {
  'use strict';

  var STORAGE_EXTRAS_KEY = 'f5vr:extras';

  /** Метаданные разблокируемых функций (id → UI). */
  var FEATURE_CATALOG = {
    x7f3a: {
      title: 'Cat Dance (Амма)',
      desc: 'Вместо текста подсказки Аммы показывается танцующий кот. Работает только когда Амма не скрыта.'
    }
  };

  /** Хеш промокода → id функций. h = SHA-256(salt + UPPER(trim(code))). */
  var PROMO_ENTRIES = [
    { h: 'a8b4fc17f82add3bae2899f21d4a5bc5ee3c7d37557b7831b1af19344943f264', f: ['x7f3a'] }
  ];

  function promoSalt() {
    return ['f5', 'vr', '', 'promo', '03'].join('');
  }

  function defaultExtras() {
    return { unlocked: [], enabled: {} };
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
    var data = new TextEncoder().encode(promoSalt() + normalized);
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
      enabled: Object.assign({}, extras.enabled)
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
        enabled: Object.assign({}, extras.enabled, { [featureId]: !!enabled })
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

  /** Точка расширения: поведение доп. функций на странице amoCRM. */
  function applyEnabledFeatures(extras, hooks) {
    hooks = hooks || {};
    if (isFeatureEnabled('x7f3a', extras) && typeof hooks.onX7f3a === 'function') {
      hooks.onX7f3a(true);
    } else if (typeof hooks.onX7f3a === 'function') {
      hooks.onX7f3a(false);
    }
  }

  global.F5VRExtras = {
    STORAGE_EXTRAS_KEY: STORAGE_EXTRAS_KEY,
    FEATURE_CATALOG: FEATURE_CATALOG,
    readExtras: readExtras,
    writeExtras: writeExtras,
    redeemPromo: redeemPromo,
    setFeatureEnabled: setFeatureEnabled,
    isFeatureUnlocked: isFeatureUnlocked,
    isFeatureEnabled: isFeatureEnabled,
    listUnlockedFeatures: listUnlockedFeatures,
    applyEnabledFeatures: applyEnabledFeatures,
    hashPromo: hashPromo
  };
})(typeof window !== 'undefined' ? window : self);
