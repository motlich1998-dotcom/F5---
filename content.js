'use strict';

(function () {
  if (window.__F5VR_CONTENT_LOADED__) return;
  window.__F5VR_CONTENT_LOADED__ = true;

  try { if (window.top !== window) return; } catch (e) { return; }

  const STORAGE_DICT_KEY = 'f5vr:dict';
  const STORAGE_SETTINGS_KEY = 'f5vr:settings';
  const STORAGE_PANEL_RECT_KEY = 'f5vr:panel_rect';
  const STORAGE_VARS_KEY = 'f5vr:vars_panel';
  const STORAGE_ENTITY_CALC_RECT_KEY = 'f5vr:entity_calc_rect';
  const TTL_MS = 24 * 3600 * 1000;
  const HOST = location.hostname;
  if (!HOST) return;

  function isAmoLikeHost() {
    return /\.amocrm\.(ru|com)$/i.test(HOST) || /\.kommo\.com$/i.test(HOST || '');
  }

  const state = {
    fields: {},
    fetchedAt: 0,
    counters: { leads: 0, contacts: 0, companies: 0, catalogs: 0, pipelines: 0, statuses: 0, users: 0, userGroups: 0 },
    errors: [],
    panelEnabled: true,
    hideAmma: false,
    extras: { unlocked: [], enabled: {} },
    idIndex: {}
  };

  function rebuildIdIndex() {
    const idx = {};
    const fields = state.fields || {};
    for (const key in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      const parts = key.split(':');
      let id;
      if (parts.length === 2) id = parts[1];
      else if (parts.length === 3) id = parts[2];
      else continue;
      if (!id) continue;
      idx[id] = true;
    }
    state.idIndex = idx;
  }

  function collectIdCandidates(id) {
    if (!id) return [];
    const out = [];
    const fields = state.fields || {};
    for (const key in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      const parts = key.split(':');
      let candId, entityKey;
      if (parts.length === 2) {
        candId = parts[1];
        entityKey = parts[0];
      } else if (parts.length === 3 && parts[0] === 'catalogs') {
        candId = parts[2];
        entityKey = 'catalogs:' + parts[1];
      } else {
        continue;
      }
      if (candId !== id) continue;
      const f = fields[key];
      out.push({
        entityKey: entityKey,
        name: f.name || '',
        type: f.type || '',
        pipelineName: f.pipelineName || '',
        catalogName: f.catalogName || '',
        groupName: f.groupName || '',
        email: f.email || '',
        isAdmin: !!f.isAdmin,
        isActive: f.isActive !== false
      });
    }
    return out;
  }
  let refreshing = false;

  let panelMounted = false;
  let elements = createEmptyElements();
  function createEmptyElements() {
    return {
      btn: null, launcherWrap: null, launcherDock: null, dockBtn: null, msDockBtn: null,
      panel: null, input: null, preview: null,
      modPanel: null, status: null, tip: null,
      vars: null, varsList: null, varsSearch: null, varsModSel: null, varsTabs: null, varsHint: null,
      ms: null, msMount: null,
      entityWidgetBtn: null, entityCalc: null, entityCalcInput: null, entityCalcResult: null,
      entityCalcStatus: null, entityCalcErrors: null
    };
  }
  let activeVarsGroup = 'all';
  let varsUserSized = false;

  async function loadExtrasFromStorage() {
    if (window.F5VRExtras && window.F5VRExtras.readExtras) {
      state.extras = await window.F5VRExtras.readExtras();
    } else {
      state.extras = { unlocked: [], enabled: {}, settings: {} };
    }
  }

  function applyExtrasFeatures() {
    if (!window.F5VRExtras || !window.F5VRExtras.applyEnabledFeatures) return;
    window.F5VRExtras.applyEnabledFeatures(state.extras, {
      onCatDance: function () {
        syncCatDance();
      },
      onMinesweeper: function () {
        syncMinesweeper();
      },
      onEntityCalc: function () {
        syncEntityCalc();
      },
      onSheetsExport: function () {
        syncSheetsExport();
      }
    });
  }

  // -------- Cat Dance (доп. функция → подсказки Аммы) --------
  const CATDANCE_STYLE_ID = 'f5ext-catdance-style';
  let catDanceObserver = null;
  let catDanceScanTimer = null;

  function isCatDanceActive() {
    const featureId = window.F5VRExtras && window.F5VRExtras.FEATURE_CATDANCE;
    return !state.hideAmma
      && window.F5VRExtras
      && featureId
      && window.F5VRExtras.isFeatureEnabled(featureId, state.extras);
  }

  function findAmmaHintRoots() {
    const roots = [];
    const seen = new Set();
    document.querySelectorAll('.svg-amma_chat--cross-close-dims').forEach((svg) => {
      const btn = svg.closest('button');
      if (!btn) return;
      const inner = btn.parentElement;
      if (!inner || inner.tagName !== 'DIV') return;
      const root = inner.parentElement;
      if (!root || root.tagName !== 'DIV') return;
      if (inner.querySelector('button') !== btn) return;
      if (seen.has(root)) return;
      seen.add(root);
      roots.push(root);
    });
    return roots;
  }

  function isInCloseButtonSubtree(el, closeBtn) {
    if (!closeBtn || !el) return false;
    return el === closeBtn || closeBtn.contains(el) || el.contains(closeBtn);
  }

  function pickBorderRadius(el) {
    if (!el || !window.getComputedStyle) return '';
    const radius = window.getComputedStyle(el).borderRadius;
    return radius && radius !== '0px' ? radius : '';
  }

  function syncCatDanceBubbleRadius(root, bubbleEl) {
    const radius = pickBorderRadius(bubbleEl) || pickBorderRadius(root) || pickBorderRadius(root && root.parentElement) || '12px';
    root.style.setProperty('--f5-cd-radius', radius);
  }

  function revertCatDanceHint(root) {
    if (!root) return;
    root.querySelectorAll('[data-f5-catdance-hidden]').forEach((el) => {
      el.style.removeProperty('display');
      el.removeAttribute('data-f5-catdance-hidden');
    });
    root.querySelectorAll('.f5ext-catdance-close').forEach((el) => {
      el.classList.remove('f5ext-catdance-close');
    });
    root.querySelectorAll('.f5ext-catdance-bubble').forEach((el) => {
      el.classList.remove('f5ext-catdance-bubble');
    });
    root.querySelectorAll('.f5ext-catdance-wrap').forEach((el) => {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    root.querySelectorAll('.f5ext-catdance-media').forEach((media) => {
      if (media.parentNode) media.parentNode.removeChild(media);
    });
    root.classList.remove('f5ext-catdance-root');
    root.removeAttribute('data-f5-catdance');
    root.style.removeProperty('--f5-cd-radius');
  }

  function cleanupOrphanCatDanceNodes() {
    document.querySelectorAll('.f5ext-catdance-media').forEach((media) => {
      if (!media.closest('[data-f5-catdance="1"]')) {
        if (media.parentNode) media.parentNode.removeChild(media);
      }
    });
    document.querySelectorAll('.f5ext-catdance-wrap').forEach((wrap) => {
      if (!wrap.closest('[data-f5-catdance="1"]')) {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }
    });
  }

  /** Блок с текстом комментария (фон «облачка»), не строка с крестиком. */
  function findAmmaHintContentHost(root, closeBtn) {
    const closeRow = closeBtn && closeBtn.parentElement;
    let best = null;
    Array.from(root.children).forEach((child) => {
      if (child === closeRow) return;
      if (child.classList.contains('f5ext-catdance-media')) return;
      const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (child.querySelector('button .svg-amma_chat--cross-close-dims')) return;
      if (!best || text.length >= (best.textContent || '').replace(/\s+/g, ' ').trim().length) {
        best = child;
      }
    });
    if (best) return best;
    return Array.from(root.children).find((child) => {
      return child !== closeRow && !child.classList.contains('f5ext-catdance-media');
    }) || root;
  }

  function hideTextInSubtree(container, closeBtn) {
    if (!container || container === closeBtn || (closeBtn && closeBtn.contains(container))) return;
    container.querySelectorAll('*').forEach((el) => {
      if (el.classList.contains('f5ext-catdance-media')) return;
      if (el.classList.contains('f5ext-catdance-wrap')) return;
      if (el.closest('.f5ext-catdance-media')) return;
      if (isInCloseButtonSubtree(el, closeBtn)) return;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (el.querySelector && el.querySelector('button .svg-amma_chat--cross-close-dims')) return;
      el.setAttribute('data-f5-catdance-hidden', '1');
      el.style.setProperty('display', 'none', 'important');
    });
    Array.from(container.childNodes).forEach((node) => {
      if (node.nodeType === 3 && (node.textContent || '').trim()) {
        node.textContent = '';
      }
    });
  }

  function getCatDanceGifUrl() {
    if (window.F5VRExtras && window.F5VRExtras.getCatDanceGifUrl) {
      return window.F5VRExtras.getCatDanceGifUrl(state.extras);
    }
    return (window.F5VRExtras && window.F5VRExtras.DEFAULT_CATDANCE_GIF_URL) || '';
  }

  function buildCatDanceMedia() {
    const media = document.createElement('div');
    media.className = 'f5ext-catdance-media';
    const img = document.createElement('img');
    img.src = getCatDanceGifUrl();
    img.alt = '';
    img.loading = 'eager';
    img.decoding = 'async';
    media.appendChild(img);
    return media;
  }

  function applyCatDanceToHint(root) {
    if (!root || root.getAttribute('data-f5-catdance') === '1') return;
    const closeBtn = root.querySelector('button .svg-amma_chat--cross-close-dims')?.closest('button');
    const closeRow = closeBtn && closeBtn.parentElement;
    const contentHost = findAmmaHintContentHost(root, closeBtn);

    hideTextInSubtree(contentHost, closeBtn);

    let mediaParent = contentHost;
    if (mediaParent === root || mediaParent === closeRow) {
      let wrap = root.querySelector(':scope > .f5ext-catdance-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'f5ext-catdance-wrap';
        root.insertBefore(wrap, closeRow || null);
      }
      mediaParent = wrap;
    }

    if (closeRow && root.contains(closeRow)) {
      closeRow.classList.add('f5ext-catdance-close');
    }

    mediaParent.classList.add('f5ext-catdance-bubble');

    if (!mediaParent.querySelector('.f5ext-catdance-media')) {
      mediaParent.appendChild(buildCatDanceMedia());
    }

    syncCatDanceBubbleRadius(root, mediaParent);

    root.classList.add('f5ext-catdance-root');
    root.setAttribute('data-f5-catdance', '1');
  }

  function scanCatDanceHints() {
    if (!isCatDanceActive()) return;
    cleanupOrphanCatDanceNodes();
    findAmmaHintRoots().forEach(applyCatDanceToHint);
  }

  function scheduleCatDanceScan() {
    if (catDanceScanTimer) clearTimeout(catDanceScanTimer);
    catDanceScanTimer = setTimeout(() => {
      catDanceScanTimer = null;
      scanCatDanceHints();
    }, 80);
  }

  function ensureCatDanceStyle() {
    const css = ''
      + 'div.f5ext-catdance-root{'
      + 'position:relative!important;display:inline-block!important;width:fit-content!important;'
      + 'min-width:0!important;max-width:min(320px,92vw)!important;padding:0!important;overflow:hidden!important;'
      + 'border-radius:var(--f5-cd-radius,12px)!important;'
      + '}'
      + '.f5ext-catdance-bubble,.f5ext-catdance-wrap{'
      + 'display:block!important;width:fit-content!important;max-width:100%!important;'
      + 'min-width:0!important;min-height:0!important;'
      + 'padding:0!important;margin:0!important;line-height:0!important;box-sizing:border-box!important;'
      + 'overflow:hidden!important;border-radius:var(--f5-cd-radius,12px)!important;'
      + '}'
      + '.f5ext-catdance-close{'
      + 'position:absolute!important;top:0!important;right:0!important;z-index:3!important;'
      + 'background:transparent!important;margin:0!important;padding:0!important;'
      + '}'
      + '.f5ext-catdance-media{'
      + 'display:block!important;width:fit-content!important;max-width:100%!important;'
      + 'padding:0!important;margin:0!important;line-height:0!important;'
      + 'overflow:hidden!important;border-radius:var(--f5-cd-radius,12px)!important;'
      + '}'
      + '.f5ext-catdance-media img{'
      + 'display:block!important;max-width:min(280px,88vw)!important;width:auto!important;height:auto!important;'
      + 'vertical-align:top!important;border-radius:var(--f5-cd-radius,12px)!important;'
      + '}';
    let style = document.getElementById(CATDANCE_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = CATDANCE_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = css;
  }

  function removeCatDanceStyle() {
    const el = document.getElementById(CATDANCE_STYLE_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function stopCatDanceObserver() {
    if (catDanceObserver) {
      catDanceObserver.disconnect();
      catDanceObserver = null;
    }
    if (catDanceScanTimer) {
      clearTimeout(catDanceScanTimer);
      catDanceScanTimer = null;
    }
  }

  function revertAllCatDanceHints() {
    document.querySelectorAll('[data-f5-catdance="1"]').forEach(revertCatDanceHint);
    cleanupOrphanCatDanceNodes();
  }

  function startCatDanceObserver() {
    stopCatDanceObserver();
    cleanupOrphanCatDanceNodes();
    if (!document.body) return;
    ensureCatDanceStyle();
    scanCatDanceHints();
    catDanceObserver = new MutationObserver(() => scheduleCatDanceScan());
    catDanceObserver.observe(document.body, { childList: true, subtree: true });
  }

  function syncCatDance() {
    if (isCatDanceActive()) startCatDanceObserver();
    else {
      stopCatDanceObserver();
      revertAllCatDanceHints();
      removeCatDanceStyle();
    }
  }

  // -------- Minesweeper (доп. функция → dock 💣) --------
  let msGame = null;

  function isMinesweeperActive() {
    const featureId = window.F5VRExtras && window.F5VRExtras.FEATURE_MINESWEEPER;
    return window.F5VRExtras
      && featureId
      && window.F5VRExtras.isFeatureEnabled(featureId, state.extras);
  }

  function isMsOpen() {
    return !!(elements.ms && elements.ms.classList.contains('is-open'));
  }

  function mountMsDockButton() {
    if (!elements.launcherDock || elements.msDockBtn) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'f5ext-dock-btn f5ext-dock-ms';
    btn.title = 'Сапёр';
    btn.setAttribute('aria-label', 'Сапёр');
    btn.textContent = '💣';
    btn.hidden = true;
    elements.launcherDock.insertBefore(btn, elements.launcherDock.firstChild);
    elements.msDockBtn = btn;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMsPanel();
    });
  }

  function syncMinesweeperDock() {
    if (!elements.msDockBtn) return;
    elements.msDockBtn.hidden = !isMinesweeperActive();
  }

  function defaultMsRect() {
    const w = syncMsPanelWidth() || 420;
    const h = 280;
    return {
      x: Math.max(8, window.innerWidth - w - 70),
      y: Math.max(8, window.innerHeight - h - 120)
    };
  }

  function getMsGameOptions() {
    if (window.F5VRExtras && window.F5VRExtras.getMinesweeperOptions) {
      return window.F5VRExtras.getMinesweeperOptions(state.extras);
    }
    return { preset: '16', boardSize: '16', rows: 16, cols: 16, mines: 40 };
  }

  function syncMsPanelWidth() {
    if (!elements.ms) return 420;
    const pad = 28;
    const w = (msGame && msGame.getPanelWidth) ? msGame.getPanelWidth() + pad : 420;
    elements.ms.style.width = w + 'px';
    return w;
  }

  function ensureMinesweeperPanel() {
    if (elements.ms) return;
    const ms = document.createElement('div');
    ms.id = 'f5ext-ms';
    ms.className = 'f5ext-ms';
    ms.innerHTML = ''
      + '<div class="f5ext-ms-shell">'
      +   '<div class="f5ext-ms-clip">'
      +     '<div class="f5ext-ms-head">'
      +       '<div class="f5ext-ms-title">Сапёр</div>'
      +       '<button type="button" class="f5ext-btn-ic js-ms-close" title="Закрыть">×</button>'
      +     '</div>'
      +     '<div class="f5ext-ms-body">'
      +       '<div class="f5ext-ms-mount"></div>'
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(ms);
    elements.ms = ms;
    elements.msMount = ms.querySelector('.f5ext-ms-mount');
    bindMsPanel();
  }

  function startMsGame() {
    if (!elements.msMount || !window.F5VRMinesweeper) return;
    if (msGame && msGame.destroy) msGame.destroy();
    const msId = window.F5VRExtras && window.F5VRExtras.FEATURE_MINESWEEPER;
    msGame = window.F5VRMinesweeper.create(elements.msMount, Object.assign({}, getMsGameOptions(), {
      onPresetChange: function (nextKey) {
        if (!window.F5VRExtras || !msId) return;
        window.F5VRExtras.setFeatureSetting(msId, 'boardSize', nextKey).then(function () {
          return loadExtrasFromStorage();
        }).then(function () {
          startMsGame();
          syncMsPanelWidth();
        });
      }
    }));
    syncMsPanelWidth();
  }

  function openMsPanel() {
    if (!isMinesweeperActive()) return;
    if (!panelMounted) mountPanel();
    ensureMinesweeperPanel();
    if (!elements.ms) return;
    const def = defaultMsRect();
    elements.ms.style.left = def.x + 'px';
    elements.ms.style.top = def.y + 'px';
    elements.ms.style.right = 'auto';
    elements.ms.style.bottom = 'auto';
    elements.ms.classList.add('is-open');
    bringToFront(elements.ms);
    if (!msGame) startMsGame();
    else syncMsPanelWidth();
    syncDockState();
  }

  function closeMsPanel() {
    if (!elements.ms) return;
    elements.ms.classList.remove('is-open');
    syncDockState();
  }

  function toggleMsPanel() {
    if (isMsOpen()) closeMsPanel();
    else openMsPanel();
  }

  function destroyMinesweeperPanel() {
    closeMsPanel();
    if (msGame && msGame.destroy) msGame.destroy();
    msGame = null;
    if (elements.ms && elements.ms.parentNode) {
      elements.ms.parentNode.removeChild(elements.ms);
    }
    elements.ms = null;
    elements.msMount = null;
  }

  function bindMsPanel() {
    if (!elements.ms) return;
    elements.ms.querySelector('.js-ms-close').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMsPanel();
    });

    const head = elements.ms.querySelector('.f5ext-ms-head');
    const drag = { active: false, dx: 0, dy: 0 };
    head.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('.f5ext-btn-ic')) return;
      if (e.button !== 0) return;
      const r = elements.ms.getBoundingClientRect();
      drag.active = true;
      drag.dx = e.clientX - r.left;
      drag.dy = e.clientY - r.top;
      elements.ms.style.right = 'auto';
      elements.ms.style.bottom = 'auto';
      elements.ms.style.left = r.left + 'px';
      elements.ms.style.top = r.top + 'px';
      bringToFront(elements.ms);
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag.active || !elements.ms) return;
      const w = elements.ms.offsetWidth || 660;
      const h = elements.ms.offsetHeight || 240;
      const x = clamp(e.clientX - drag.dx, 6, window.innerWidth - Math.max(60, w - 40));
      const y = clamp(e.clientY - drag.dy, 6, window.innerHeight - Math.max(60, h - 40));
      elements.ms.style.left = x + 'px';
      elements.ms.style.top = y + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!drag.active || !elements.entityCalc) return;
      drag.active = false;
      const rr = elements.entityCalc.getBoundingClientRect();
      saveEntityCalcRect({
        x: Math.round(rr.left),
        y: Math.round(rr.top),
        w: Math.round(rr.width),
        h: Math.round(rr.height)
      });
    });

    elements.ms.addEventListener('mousedown', () => bringToFront(elements.ms), true);
  }

  function syncMinesweeper() {
    syncMinesweeperDock();
    if (!isMinesweeperActive()) {
      destroyMinesweeperPanel();
    }
  }

  // -------- Entity formula MVP (доп. функция → результат :calc на карточке) --------
  let entityCalcObserver = null;
  let entityCalcScanTimer = null;
  let entityCalcHistoryHooked = false;
  let entityCalcContext = null;
  let entityCalcContextKey = '';
  let entityCalcLoading = null;
  let sheetsExportObserver = null;
  let sheetsExportScanTimer = null;

  function isEntityCalcActive() {
    const featureId = window.F5VRExtras && window.F5VRExtras.FEATURE_ENTITY_CALC;
    return window.F5VRExtras
      && featureId
      && window.F5VRExtras.isFeatureEnabled(featureId, state.extras);
  }

  function currentEntityRoute() {
    const m = location.pathname.match(/^\/(leads|contacts|companies)\/detail\/(\d+)/);
    if (!m) return null;
    const root = m[1] === 'leads' ? 'lead' : m[1] === 'contacts' ? 'contact' : 'company';
    return { plural: m[1], root: root, id: m[2], key: m[1] + ':' + m[2] };
  }

  function scheduleEntityCalcScan() {
    if (!isEntityCalcActive()) return;
    if (entityCalcScanTimer) clearTimeout(entityCalcScanTimer);
    entityCalcScanTimer = setTimeout(() => {
      entityCalcScanTimer = null;
      syncEntityCalcWidget();
    }, 120);
  }

  function hookEntityCalcHistory() {
    if (entityCalcHistoryHooked) return;
    entityCalcHistoryHooked = true;
    ['pushState', 'replaceState'].forEach((name) => {
      const original = history[name];
      if (!original || original.__f5vrEntityCalcHooked) return;
      const wrapped = function () {
        const res = original.apply(this, arguments);
        window.dispatchEvent(new Event('F5VR_LOCATION_CHANGED'));
        return res;
      };
      wrapped.__f5vrEntityCalcHooked = true;
      history[name] = wrapped;
    });
    window.addEventListener('popstate', scheduleEntityCalcScan);
    window.addEventListener('F5VR_LOCATION_CHANGED', scheduleEntityCalcScan);
  }

  function visibleRect(el) {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) return null;
    const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0)) return null;
    return r;
  }

  function findAmoWidgetsHeaderHost() {
    const nodes = Array.from(document.querySelectorAll('aside, section, div, h1, h2, h3, span'));
    let best = null;
    let bestTop = Infinity;
    nodes.forEach((el) => {
      if (el.id && /^f5ext-/.test(el.id)) return;
      const directText = Array.from(el.childNodes).filter((n) => n.nodeType === 3)
        .map((n) => n.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
      const text = directText || (el.children.length ? '' : (el.textContent || '').replace(/\s+/g, ' ').trim());
      if (text !== 'Виджеты') return;
      const r = visibleRect(el);
      if (!r) return;
      if (r.right < window.innerWidth * 0.75) return;
      const host = el.parentElement;
      if (!host || (host.id && /^f5ext-/.test(host.id))) return;
      const hr = host.getBoundingClientRect ? host.getBoundingClientRect() : null;
      if (!hr || hr.width < 120 || hr.width > 460) return;
      if (r.top < bestTop) {
        bestTop = r.top;
        best = host;
      }
    });
    return best;
  }

  function createEntityWidgetButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'f5ext-entity-widget-btn';
    btn.textContent = 'F5 Формула';
    btn.title = 'Проверить формулу по текущей сущности';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEntityCalcPanel();
    });
    elements.entityWidgetBtn = btn;
    return btn;
  }

  function removeEntityWidgetButton() {
    if (elements.entityWidgetBtn && elements.entityWidgetBtn.parentNode) {
      elements.entityWidgetBtn.parentNode.removeChild(elements.entityWidgetBtn);
    }
    elements.entityWidgetBtn = null;
  }

  function syncEntityCalcWidget() {
    const route = currentEntityRoute();
    if (!isEntityCalcActive() || !route) {
      removeEntityWidgetButton();
      if (elements.entityCalc) closeEntityCalcPanel();
      return;
    }

    ensureStyles();
    const btn = elements.entityWidgetBtn || createEntityWidgetButton();
    btn.classList.remove('is-floating', 'is-header');
    const host = findAmoWidgetsHeaderHost();
    if (host) {
      host.classList.add('f5ext-entity-widget-host');
      btn.classList.add('is-header');
      if (btn.parentNode !== host) host.appendChild(btn);
    } else {
      btn.classList.add('is-floating');
      if (btn.parentNode !== document.body) document.body.appendChild(btn);
    }
    if (elements.entityCalc && elements.entityCalc.classList.contains('is-open')) {
      if (entityCalcContextKey !== route.key) {
        entityCalcContext = null;
        entityCalcContextKey = '';
        setEntityCalcStatus('', '');
        if (elements.entityCalcResult) elements.entityCalcResult.textContent = '';
      }
    }
  }

  function startEntityCalcObserver() {
    stopEntityCalcObserver();
    if (!document.body) return;
    ensureStyles();
    hookEntityCalcHistory();
    syncEntityCalcWidget();
    entityCalcObserver = new MutationObserver(scheduleEntityCalcScan);
    entityCalcObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopEntityCalcObserver() {
    if (entityCalcObserver) {
      entityCalcObserver.disconnect();
      entityCalcObserver = null;
    }
    if (entityCalcScanTimer) {
      clearTimeout(entityCalcScanTimer);
      entityCalcScanTimer = null;
    }
  }

  function defaultEntityCalcRect() {
    const w = 520;
    const h = 430;
    return {
      x: Math.max(8, window.innerWidth - w - 90),
      y: Math.max(8, Math.min(140, window.innerHeight - h - 24)),
      w: w,
      h: h
    };
  }

  function getEntityCalcRect() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_ENTITY_CALC_RECT_KEY, (raw) => {
        resolve(raw[STORAGE_ENTITY_CALC_RECT_KEY] || null);
      });
    });
  }

  function saveEntityCalcRect(rect) {
    const patch = {};
    patch[STORAGE_ENTITY_CALC_RECT_KEY] = rect;
    chrome.storage.local.set(patch);
  }

  function ensureEntityCalcPanel() {
    if (elements.entityCalc) return;
    const panel = document.createElement('div');
    panel.id = 'f5ext-entity-calc';
    panel.className = 'f5ext-entity-calc';
    panel.innerHTML = ''
      + '<div class="f5ext-entity-calc-shell">'
      +   '<div class="f5ext-resize" data-dir="n"></div>'
      +   '<div class="f5ext-resize" data-dir="s"></div>'
      +   '<div class="f5ext-resize" data-dir="e"></div>'
      +   '<div class="f5ext-resize" data-dir="w"></div>'
      +   '<div class="f5ext-resize" data-dir="ne"></div>'
      +   '<div class="f5ext-resize" data-dir="nw"></div>'
      +   '<div class="f5ext-resize" data-dir="se"></div>'
      +   '<div class="f5ext-resize" data-dir="sw"></div>'
      +   '<div class="f5ext-entity-calc-head">'
      +     '<div class="f5ext-entity-calc-title">F5 — формула по сущности</div>'
      +     '<div class="f5ext-entity-calc-actions">'
      +       '<button type="button" class="f5ext-btn-ic js-entity-vars" title="Шаблонизатор переменных">{…}</button>'
      +       '<button type="button" class="f5ext-btn-ic js-entity-close" title="Закрыть">×</button>'
      +     '</div>'
      +   '</div>'
      +   '<div class="f5ext-entity-calc-body">'
      +     '<div class="f5ext-entity-calc-status" hidden></div>'
      +     '<textarea class="f5ext-entity-calc-input" spellcheck="false"></textarea>'
      +     '<div class="f5ext-entity-calc-errors" hidden></div>'
      +     '<div class="f5ext-entity-calc-runrow">'
      +       '<button type="button" class="f5ext-entity-calc-run js-entity-run">Проверить</button>'
      +     '</div>'
      +     '<div class="f5ext-entity-calc-result"><div class="f5ext-entity-calc-subtitle">Результат</div><div class="f5ext-entity-calc-output"></div></div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(panel);
    elements.entityCalc = panel;
    elements.entityCalcInput = panel.querySelector('.f5ext-entity-calc-input');
    elements.entityCalcResult = panel.querySelector('.f5ext-entity-calc-output');
    elements.entityCalcStatus = panel.querySelector('.f5ext-entity-calc-status');
    elements.entityCalcErrors = panel.querySelector('.f5ext-entity-calc-errors');
    bindEntityCalcPanel();
  }

  function destroyEntityCalcPanel() {
    if (elements.entityCalc && elements.entityCalc.parentNode) {
      elements.entityCalc.parentNode.removeChild(elements.entityCalc);
    }
    elements.entityCalc = null;
    elements.entityCalcInput = null;
    elements.entityCalcResult = null;
    elements.entityCalcStatus = null;
    elements.entityCalcErrors = null;
    entityCalcContext = null;
    entityCalcContextKey = '';
  }

  function closeEntityCalcPanel() {
    if (!elements.entityCalc) return;
    elements.entityCalc.classList.remove('is-open');
  }

  function setEntityCalcStatus(text, kind) {
    if (!elements.entityCalcStatus) return;
    elements.entityCalcStatus.textContent = text || '';
    elements.entityCalcStatus.hidden = !text;
    elements.entityCalcStatus.classList.remove('is-ok', 'is-err', 'is-progress');
    if (kind) elements.entityCalcStatus.classList.add(kind);
  }

  function setEntityCalcErrors(errors) {
    if (!elements.entityCalcErrors) return;
    const list = Array.from(new Set((errors || []).filter(Boolean)));
    elements.entityCalcErrors.hidden = list.length === 0;
    elements.entityCalcErrors.innerHTML = list.length
      ? '<div class="f5ext-entity-calc-subtitle">Ошибки</div>'
        + list.map((err) => '<div class="f5ext-entity-error">' + escapeHtml(err) + '</div>').join('')
      : '';
    if (elements.entityCalcInput) elements.entityCalcInput.classList.toggle('is-error', list.length > 0);
  }

  function openEntityCalcPanel() {
    const route = currentEntityRoute();
    if (!isEntityCalcActive() || !route) return;
    ensureEntityCalcPanel();
    const def = defaultEntityCalcRect();
    getEntityCalcRect().then((stored) => {
      if (!elements.entityCalc) return;
      const maxW = Math.floor(window.innerWidth * 0.96);
      const maxH = Math.floor(window.innerHeight * 0.92);
      const w = clamp((stored && stored.w) || def.w, 380, maxW);
      const h = clamp((stored && stored.h) || def.h, 300, maxH);
      const x = clamp((stored && stored.x != null) ? stored.x : def.x, 6, window.innerWidth - 80);
      const y = clamp((stored && stored.y != null) ? stored.y : def.y, 6, window.innerHeight - 60);
      elements.entityCalc.style.left = x + 'px';
      elements.entityCalc.style.top = y + 'px';
      elements.entityCalc.style.width = w + 'px';
      elements.entityCalc.style.height = h + 'px';
      elements.entityCalc.style.right = 'auto';
      elements.entityCalc.style.bottom = 'auto';
    });
    elements.entityCalc.classList.add('is-open');
    bringToFront(elements.entityCalc);
    setEntityCalcStatus('', '');
    setEntityCalcErrors([]);
    if (elements.entityCalcResult) elements.entityCalcResult.textContent = '';
  }

  function bindEntityCalcPanel() {
    if (!elements.entityCalc) return;
    elements.entityCalc.querySelector('.js-entity-close').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeEntityCalcPanel();
    });
    elements.entityCalc.querySelector('.js-entity-vars').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!panelMounted) mountPanel();
      if (elements.vars) toggleVarsPanel();
    });
    elements.entityCalc.querySelector('.js-entity-run').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      loadEntityCalcContext(true).then(evaluateEntityCalcInput);
    });
    elements.entityCalcInput.addEventListener('input', () => {
      if (elements.entityCalcResult) elements.entityCalcResult.textContent = '';
      setEntityCalcErrors([]);
    });

    const head = elements.entityCalc.querySelector('.f5ext-entity-calc-head');
    const drag = { active: false, dx: 0, dy: 0 };
    head.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('.f5ext-btn-ic')) return;
      if (e.button !== 0) return;
      const r = elements.entityCalc.getBoundingClientRect();
      drag.active = true;
      drag.dx = e.clientX - r.left;
      drag.dy = e.clientY - r.top;
      bringToFront(elements.entityCalc);
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag.active || !elements.entityCalc) return;
      const w = elements.entityCalc.offsetWidth || 520;
      const h = elements.entityCalc.offsetHeight || 420;
      elements.entityCalc.style.left = clamp(e.clientX - drag.dx, 6, window.innerWidth - Math.max(60, w - 40)) + 'px';
      elements.entityCalc.style.top = clamp(e.clientY - drag.dy, 6, window.innerHeight - Math.max(60, h - 40)) + 'px';
    });
    document.addEventListener('mouseup', () => { drag.active = false; });
    elements.entityCalc.addEventListener('mousedown', () => bringToFront(elements.entityCalc), true);

    const rs = { active: false, dir: '', sx: 0, sy: 0, start: null };
    function getEntityCalcMinMax() {
      return {
        minW: 380,
        minH: 300,
        maxW: Math.floor(window.innerWidth * 0.96),
        maxH: Math.floor(window.innerHeight * 0.92)
      };
    }
    elements.entityCalc.querySelectorAll('.f5ext-resize').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const r = elements.entityCalc.getBoundingClientRect();
        rs.active = true;
        rs.dir = handle.getAttribute('data-dir') || '';
        rs.sx = e.clientX;
        rs.sy = e.clientY;
        rs.start = { left: r.left, top: r.top, width: r.width, height: r.height };
        elements.entityCalc.style.right = 'auto';
        elements.entityCalc.style.bottom = 'auto';
        elements.entityCalc.style.left = r.left + 'px';
        elements.entityCalc.style.top = r.top + 'px';
        elements.entityCalc.style.width = r.width + 'px';
        elements.entityCalc.style.height = r.height + 'px';
        bringToFront(elements.entityCalc);
        e.preventDefault();
        e.stopPropagation();
      });
    });
    document.addEventListener('mousemove', (e) => {
      if (!rs.active || !rs.start || !elements.entityCalc) return;
      const dx = e.clientX - rs.sx;
      const dy = e.clientY - rs.sy;
      const dir = rs.dir;
      const r0 = rs.start;
      const mm = getEntityCalcMinMax();
      let left = r0.left;
      let top = r0.top;
      let w = r0.width;
      let h = r0.height;
      if (dir.indexOf('e') !== -1) w = r0.width + dx;
      if (dir.indexOf('s') !== -1) h = r0.height + dy;
      if (dir.indexOf('w') !== -1) { w = r0.width - dx; left = r0.left + dx; }
      if (dir.indexOf('n') !== -1) { h = r0.height - dy; top = r0.top + dy; }
      w = clamp(w, mm.minW, mm.maxW);
      h = clamp(h, mm.minH, mm.maxH);
      left = clamp(left, 6, window.innerWidth - Math.max(60, w - 10));
      top = clamp(top, 6, window.innerHeight - Math.max(60, h - 10));
      elements.entityCalc.style.left = Math.round(left) + 'px';
      elements.entityCalc.style.top = Math.round(top) + 'px';
      elements.entityCalc.style.width = Math.round(w) + 'px';
      elements.entityCalc.style.height = Math.round(h) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!rs.active || !elements.entityCalc) return;
      rs.active = false;
      const rr = elements.entityCalc.getBoundingClientRect();
      saveEntityCalcRect({
        x: Math.round(rr.left),
        y: Math.round(rr.top),
        w: Math.round(rr.width),
        h: Math.round(rr.height)
      });
    });
  }

  async function loadEntityCalcContext(force) {
    const route = currentEntityRoute();
    if (!route || !window.F5VRApi || !window.F5VRApi.fetchEntityFormulaContext) return null;
    if (!force && entityCalcContext && entityCalcContextKey === route.key) return entityCalcContext;
    if (entityCalcLoading && !force) return entityCalcLoading;
    setEntityCalcStatus('Загружаю данные сущности…', 'is-progress');
    entityCalcContextKey = route.key;
    entityCalcLoading = window.F5VRApi.fetchEntityFormulaContext(route.root, route.id)
      .then((ctx) => {
        entityCalcContext = ctx;
        setEntityCalcStatus('', '');
        return ctx;
      })
      .catch((e) => {
        entityCalcContext = null;
        setEntityCalcStatus('Не удалось загрузить сущность: ' + (e && e.message ? e.message : String(e)), 'is-err');
        return null;
      })
      .finally(() => {
        entityCalcLoading = null;
      });
    return entityCalcLoading;
  }

  function entityByRoot(ctx, root) {
    if (!ctx) return null;
    if (root === 'lead') return ctx.lead;
    if (root === 'contact') return ctx.contact;
    if (root === 'company') return ctx.company;
    return null;
  }

  function entityPluralByRoot(root) {
    if (root === 'lead') return 'leads';
    if (root === 'contact') return 'contacts';
    if (root === 'company') return 'companies';
    return '';
  }

  function normalizeEntityRefId(raw) {
    const s = String(raw || '').trim();
    if (/^\d+$/.test(s)) return s;
    const m = s.match(/^id\s*(\d+)$/i);
    return m ? m[1] : '';
  }

  function entityId(entity) {
    return entity && entity.id != null ? String(entity.id) : '';
  }

  async function loadEntityForFormula(ctx, root, rawId, cache, errors) {
    const id = normalizeEntityRefId(rawId);
    if (!id) {
      errors.push('Некорректный id сущности: ' + rawId);
      return null;
    }

    const current = entityByRoot(ctx, root);
    if (current && entityId(current) === id) return current;

    const key = root + ':' + id;
    if (cache[key]) return cache[key];

    if (!window.F5VRApi || !window.F5VRApi.loadEntity) {
      errors.push('API загрузки сущностей недоступен');
      return null;
    }

    cache[key] = window.F5VRApi.loadEntity(root, id, ['contacts', 'companies', 'leads'])
      .catch((e) => {
        errors.push(root + '(' + id + '): ' + (e && e.message ? e.message : String(e)));
        return null;
      });
    return cache[key];
  }

  function currentRootForCtx(ctx) {
    if (!ctx || !ctx.current || !ctx.current.type) return '';
    if (ctx.current.type === 'leads') return 'lead';
    if (ctx.current.type === 'contacts') return 'contact';
    if (ctx.current.type === 'companies') return 'company';
    return '';
  }

  function linkCatalogId(link) {
    const md = link && link.metadata ? link.metadata : {};
    return String(md.catalog_id || md.catalogId || link.catalog_id || link.catalogId || '');
  }

  function linkEntityId(link) {
    return String((link && (link.to_entity_id || link.entity_id || link.id)) || '');
  }

  async function findLinkedCatalogElementId(ctx, catalogId, cache) {
    const root = currentRootForCtx(ctx);
    const current = root ? entityByRoot(ctx, root) : null;
    const currentId = entityId(current);
    if (!root || !currentId || !window.F5VRApi || !window.F5VRApi.loadEntityLinks) return '';
    const key = 'links:' + root + ':' + currentId;
    if (!cache[key]) cache[key] = window.F5VRApi.loadEntityLinks(root, currentId).catch(() => []);
    const links = await cache[key];
    const matches = (links || []).filter((link) => {
      const type = link && (link.to_entity_type || link.entity_type);
      if (type !== 'catalog_elements') return false;
      const cid = linkCatalogId(link);
      return !cid || String(cid) === String(catalogId);
    });
    return matches.length ? linkEntityId(matches[0]) : '';
  }

  async function loadCatalogElementForFormula(ctx, selector, catalogId, cache, errors) {
    let elementId = normalizeEntityRefId(selector);
    if (!elementId && String(selector || '').trim().toLowerCase() === 'first') {
      elementId = await findLinkedCatalogElementId(ctx, catalogId, cache);
    }
    if (!elementId) {
      errors.push('Не найден элемент каталога ' + catalogId + ' для selector=' + selector);
      return null;
    }
    const key = 'catalog:' + catalogId + ':' + elementId;
    if (cache[key]) return cache[key];
    if (!window.F5VRApi || !window.F5VRApi.loadCatalogElement) {
      errors.push('API загрузки элементов каталога недоступен');
      return null;
    }
    cache[key] = window.F5VRApi.loadCatalogElement(catalogId, elementId)
      .catch((e) => {
        errors.push('catalogElement(' + selector + ', ' + catalogId + '): ' + (e && e.message ? e.message : String(e)));
        return null;
      });
    return cache[key];
  }

  function fieldMetaForRoot(root, fieldId) {
    const plural = entityPluralByRoot(root);
    return plural && state.fields ? state.fields[plural + ':' + fieldId] : null;
  }

  function fieldMetaForCatalog(catalogId, fieldId) {
    return state.fields ? state.fields['catalogs:' + catalogId + ':' + fieldId] : null;
  }

  function enumLabel(meta, value, enumId) {
    const enums = meta && meta.enums;
    if (enums && enums.byId && enumId != null && enums.byId[String(enumId)] != null) {
      return enums.byId[String(enumId)];
    }
    return value != null ? value : (enumId != null ? enumId : '');
  }

  function normalizeFieldSingleValue(v, meta) {
    if (!v) return '';
    const type = String((meta && meta.type) || '').toLowerCase();
    const raw = v.value != null ? v.value : '';
    const enumId = v.enum_id != null ? v.enum_id : '';

    if (type === 'select' || type === 'multiselect' || type === 'radiobutton') {
      return enumLabel(meta, raw, enumId);
    }
    if (type === 'checkbox') {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') return '1';
      if (raw === false || raw === 'false' || raw === 0 || raw === '0') return '0';
      return enumLabel(meta, raw, enumId);
    }
    if (type === 'numeric' || type === 'price') {
      return raw != null && raw !== '' ? toCalcNumber(raw) : '';
    }
    if (type === 'date' || type === 'date_time' || type === 'birthday') {
      return raw != null ? raw : '';
    }
    return raw != null && raw !== '' ? raw : enumLabel(meta, raw, enumId);
  }

  function getEntityFieldValue(entity, fieldId, root, separator) {
    const fields = entity && entity.custom_fields_values;
    if (!Array.isArray(fields)) return '';
    const f = fields.find((it) => String(it.field_id) === String(fieldId));
    if (!f || !Array.isArray(f.values) || !f.values.length) return '';
    const meta = root ? fieldMetaForRoot(root, fieldId) : null;
    const values = f.values.map((v) => normalizeFieldSingleValue(v, meta)).filter((v) => v !== '');
    return values.join(separator == null ? ', ' : separator);
  }

  function getCatalogElementFieldValue(element, catalogId, fieldId, separator) {
    const fields = element && element.custom_fields_values;
    if (!Array.isArray(fields)) return '';
    const f = fields.find((it) => String(it.field_id) === String(fieldId));
    if (!f || !Array.isArray(f.values) || !f.values.length) return '';
    const meta = fieldMetaForCatalog(catalogId, fieldId);
    const values = f.values.map((v) => normalizeFieldSingleValue(v, meta)).filter((v) => v !== '');
    return values.join(separator == null ? ', ' : separator);
  }

  function getEntitySystemValue(entity, root, prop) {
    if (!entity) return '';
    const p = String(prop || '').toLowerCase();
    const nameParts = String(entity.name || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (p === 'id') return entity.id || '';
    if (p === 'name') return entity.name || '';
    if (root === 'lead' && (p === 'sale' || p === 'price' || p === 'budget')) return entity.price || 0;
    if (p === 'responsible_user_id') return entity.responsible_user_id || '';
    if (p === 'created_at') return entity.created_at || '';
    if (p === 'updated_at') return entity.updated_at || '';
    if (p === 'closed_at') return entity.closed_at || '';
    if (p === 'status_id') return entity.status_id || '';
    if (p === 'pipeline_id') return entity.pipeline_id || '';
    if (p === 'first_name') return entity.first_name || nameParts[1] || nameParts[0] || '';
    if (p === 'last_name') return entity.last_name || (nameParts.length > 1 ? nameParts[0] : '');
    return entity[prop] != null ? entity[prop] : '';
  }

  function fieldLabelForRoot(root, fieldId) {
    const meta = fieldMetaForRoot(root, fieldId);
    return (meta && meta.name) || (root + '.cf(' + fieldId + ')');
  }

  function fieldTypeForRoot(root, fieldId) {
    const meta = fieldMetaForRoot(root, fieldId);
    return (meta && meta.type) || '';
  }

  function fieldLabelForCatalog(catalogId, fieldId) {
    const meta = fieldMetaForCatalog(catalogId, fieldId);
    return (meta && meta.name) || ('catalogElement(' + catalogId + ').cf(' + fieldId + ')');
  }

  function fieldTypeForCatalog(catalogId, fieldId) {
    const meta = fieldMetaForCatalog(catalogId, fieldId);
    return (meta && meta.type) || '';
  }

  function toCalcNumber(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') return isFinite(value) ? value : 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const cleaned = String(value)
      .replace(/\s+/g, '')
      .replace(',', '.')
      .replace(/[^0-9.+-]/g, '');
    const n = Number(cleaned);
    return isFinite(n) ? n : 0;
  }

  function splitModifierChain(chain) {
    const out = [];
    let cur = '';
    let depth = 0;
    const s = String(chain || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      if (ch === ')' && depth > 0) depth--;
      if (ch === ':' && depth === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function parseModifier(mod) {
    const m = String(mod || '').trim().match(/^([a-zA-Z_][\w-]*)(?:\(([\s\S]*)\))?$/);
    if (!m) return { name: String(mod || '').trim().toLowerCase(), args: [] };
    return {
      name: m[1].toLowerCase(),
      args: splitArgs(m[2] || '')
    };
  }

  function splitArgs(raw) {
    if (raw == null || raw === '') return [];
    const out = [];
    let cur = '';
    let depth = 0;
    const s = String(raw);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const prev = s[i - 1];
      if (ch === '(') depth++;
      if (ch === ')' && depth > 0) depth--;
      if (ch === ',' && depth === 0 && prev !== '\\') {
        out.push(unescapeModifierArg(cur.trim()));
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(unescapeModifierArg(cur.trim()));
    return out;
  }

  function unescapeModifierArg(s) {
    return String(s || '')
      .replace(/\\,/g, ',')
      .replace(/\\\./g, '.')
      .replace(/\\:/g, ':');
  }

  function isEmptyValue(v) {
    return v == null || String(v).trim() === '';
  }

  function formatNumber(value, args) {
    const n = toCalcNumber(value);
    const decimals = args[0] !== undefined && args[0] !== '' ? Math.max(0, Number(args[0]) || 0) : 0;
    const decSep = args[1] !== undefined ? args[1] : '.';
    const thSep = args[2] !== undefined ? args[2] : ' ';
    const parts = n.toFixed(decimals).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thSep);
    return parts.length > 1 ? parts[0] + decSep + parts[1] : parts[0];
  }

  function dateFromValue(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return value;
    if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
      const n = Number(value);
      return new Date(n > 100000000000 ? n : n * 1000);
    }
    const d = new Date(String(value));
    return isNaN(d.getTime()) ? null : d;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatDate(value, fmt) {
    const d = dateFromValue(value);
    if (!d) return '';
    const monthsRu = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const format = String(fmt || 'd.m.Y');
    let out = '';
    for (let i = 0; i < format.length; i++) {
      const ch = format[i];
      if (ch === '\\') {
        i++;
        out += format[i] || '';
      } else if (ch === 'd') out += pad2(d.getDate());
      else if (ch === 'j') out += String(d.getDate());
      else if (ch === 'm') out += pad2(d.getMonth() + 1);
      else if (ch === 'n') out += String(d.getMonth() + 1);
      else if (ch === 'Y') out += String(d.getFullYear());
      else if (ch === 'y') out += String(d.getFullYear()).slice(-2);
      else if (ch === 'H') out += pad2(d.getHours());
      else if (ch === 'i') out += pad2(d.getMinutes());
      else if (ch === 's') out += pad2(d.getSeconds());
      else if (ch === 'U') out += String(Math.floor(d.getTime() / 1000));
      else if (ch === 'F') out += monthsRu[d.getMonth()];
      else out += ch;
    }
    return out;
  }

  function spellDateRu(value) {
    const d = dateFromValue(value);
    if (!d) return '';
    return spellNumRu(d.getDate()) + ' ' + formatDate(d, 'F') + ' ' + spellNumRu(d.getFullYear()) + ' года';
  }

  function addDatePart(date, amount, unit) {
    const d = new Date(date.getTime());
    const u = String(unit || '').toLowerCase();
    if (u.indexOf('month') !== -1 || u.indexOf('меся') !== -1) d.setMonth(d.getMonth() + amount);
    else if (u.indexOf('year') !== -1 || u.indexOf('год') !== -1 || u.indexOf('лет') !== -1) d.setFullYear(d.getFullYear() + amount);
    else if (u.indexOf('hour') !== -1 || u.indexOf('час') !== -1) d.setHours(d.getHours() + amount);
    else if (u.indexOf('minute') !== -1 || u.indexOf('мин') !== -1) d.setMinutes(d.getMinutes() + amount);
    else d.setDate(d.getDate() + amount);
    return d;
  }

  function isBasicWorkdayDate(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return false;
    const day = date.getDay();
    return day >= 1 && day <= 5;
  }

  function addBasicWorkdays(value, days, fmt) {
    const d = dateFromValue(value);
    if (!d) return '';
    let left = Math.abs(Number(days) || 0);
    const dir = (Number(days) || 0) < 0 ? -1 : 1;
    const cur = new Date(d.getTime());
    while (left > 0) {
      cur.setDate(cur.getDate() + dir);
      if (isBasicWorkdayDate(cur)) left--;
    }
    return formatDate(cur, fmt || 'd.m.Y');
  }

  function shiftToBasicWorkday(value, dir, fmt) {
    const d = dateFromValue(value);
    if (!d) return '';
    const cur = new Date(d.getTime());
    do {
      cur.setDate(cur.getDate() + dir);
    } while (!isBasicWorkdayDate(cur));
    return formatDate(cur, fmt || 'd.m.Y');
  }

  function modifyDate(value, fmt, expr) {
    let d = dateFromValue(value);
    if (!d) return '';
    const raw = String(expr || '').trim().toLowerCase();
    if (!raw) return formatDate(d, fmt);
    if (raw === 'last day of next month') {
      d = new Date(d.getFullYear(), d.getMonth() + 2, 0, d.getHours(), d.getMinutes(), d.getSeconds());
    } else if (raw === 'last day of this month') {
      d = new Date(d.getFullYear(), d.getMonth() + 1, 0, d.getHours(), d.getMinutes(), d.getSeconds());
    } else if (raw === 'first day of next month') {
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1, d.getHours(), d.getMinutes(), d.getSeconds());
    } else if (raw === 'first day of this month') {
      d = new Date(d.getFullYear(), d.getMonth(), 1, d.getHours(), d.getMinutes(), d.getSeconds());
    } else if (raw === 'next month') {
      d = addDatePart(d, 1, 'month');
    } else if (raw === 'previous month' || raw === 'last month') {
      d = addDatePart(d, -1, 'month');
    } else {
      const m = raw.match(/^([+-]?\d+)\s*(day|days|день|дня|дней|month|months|месяц|месяца|месяцев|year|years|год|года|лет|hour|hours|час|часа|часов|minute|minutes|минута|минут|минуты)$/i);
      if (m) d = addDatePart(d, Number(m[1]), m[2]);
    }
    return formatDate(d, fmt);
  }

  function formatDateDiff(value, args) {
    const d1 = dateFromValue(value);
    const d2 = dateFromValue(args[0] || Math.floor(Date.now() / 1000));
    if (!d1 || !d2) return '';
    let diff = Math.abs(d2.getTime() - d1.getTime());
    const totalSeconds = Math.floor(diff / 1000);
    const totalDays = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const months = Math.floor(totalDays / 30);
    const days = totalDays % 30;
    const fmt = args[1] || '%a';
    return String(fmt)
      .replace(/%a/g, String(totalDays))
      .replace(/%m/g, String(months))
      .replace(/%d/g, String(days))
      .replace(/%h/g, String(hours))
      .replace(/%i/g, String(minutes))
      .replace(/%s/g, String(seconds));
  }

  function translitRu(value) {
    const map = {
      а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
      к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
      х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
    };
    return String(value || '').split('').map((ch) => {
      const low = ch.toLowerCase();
      const tr = map[low];
      if (tr === undefined) return ch;
      return ch === low ? tr : tr.charAt(0).toUpperCase() + tr.slice(1);
    }).join('');
  }

  function fioParts(value) {
    const p = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    return { f: p[0] || '', i: p[1] || '', o: p[2] || '', raw: p.join(' ') };
  }

  function applyFio(value, args) {
    const p = fioParts(value);
    const part = String(args[0] || '').trim();
    if (part === '1') return p.i || p.raw;
    if (part === '2') return p.f || p.raw;
    if (part === '3') return p.o || '';
    return p.raw;
  }

  function applyFioFormat(value, args) {
    const p = fioParts(value);
    const fmt = args[0] || 'F I O';
    const initials = {
      f: p.f ? p.f.charAt(0).toUpperCase() : '',
      i: p.i ? p.i.charAt(0).toUpperCase() : '',
      o: p.o ? p.o.charAt(0).toUpperCase() : ''
    };
    return String(fmt)
      .replace(/F/g, p.f)
      .replace(/I/g, p.i)
      .replace(/O/g, p.o)
      .replace(/f/g, initials.f)
      .replace(/i/g, initials.i)
      .replace(/o/g, initials.o)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function partValue(value, args) {
    const mode = String(args[0] || 'br').toLowerCase();
    const items = String(value || '').split(/\r?\n|,\s*/).map((s) => s.trim()).filter(Boolean);
    if (mode === 'rn') return items.join('\r\n');
    if (mode === 'ul') return items.map((s) => '• ' + s).join('\n');
    if (mode === 'ol') return items.map((s, i) => (i + 1) + '. ' + s).join('\n');
    return items.join('<br>');
  }

  function pluralIndex(n) {
    const v = Math.abs(Math.floor(Number(n) || 0));
    if (v % 100 >= 11 && v % 100 <= 14) return 2;
    if (v % 10 === 1) return 0;
    if (v % 10 >= 2 && v % 10 <= 4) return 1;
    return 2;
  }

  function nounPlural(value, args) {
    const n = toCalcNumber(value);
    let forms = args;
    if (forms.length === 1 && forms[0].indexOf('|') !== -1) forms = forms[0].split('|');
    if (forms.length >= 3) return String(value || '0') + ' ' + (forms[pluralIndex(n)] || forms[2]);
    if (forms.length === 1) return String(value || '0') + ' ' + forms[0];
    return String(value || '');
  }

  function spellNumRu(value) {
    let n = Math.floor(Math.abs(toCalcNumber(value)));
    if (n === 0) return 'ноль';
    const unitsM = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
    const unitsF = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
    const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
    const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
    const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
    const scales = [
      ['', '', '', 'm'],
      ['тысяча', 'тысячи', 'тысяч', 'f'],
      ['миллион', 'миллиона', 'миллионов', 'm'],
      ['миллиард', 'миллиарда', 'миллиардов', 'm']
    ];
    const words = [];
    let scale = 0;
    while (n > 0 && scale < scales.length) {
      const chunk = n % 1000;
      if (chunk) {
        const gender = scales[scale][3];
        const units = gender === 'f' ? unitsF : unitsM;
        const part = [];
        part.push(hundreds[Math.floor(chunk / 100)]);
        const rest = chunk % 100;
        if (rest >= 10 && rest <= 19) part.push(teens[rest - 10]);
        else {
          part.push(tens[Math.floor(rest / 10)]);
          part.push(units[rest % 10]);
        }
        if (scale > 0) part.push(scales[scale][pluralIndex(chunk)]);
        words.unshift(part.filter(Boolean).join(' '));
      }
      n = Math.floor(n / 1000);
      scale++;
    }
    return (toCalcNumber(value) < 0 ? 'минус ' : '') + words.filter(Boolean).join(' ');
  }

  function ordinalNumRu(value) {
    const n = Math.abs(Math.floor(toCalcNumber(value)));
    const map = {
      1: 'первый', 2: 'второй', 3: 'третий', 4: 'четвёртый', 5: 'пятый',
      6: 'шестой', 7: 'седьмой', 8: 'восьмой', 9: 'девятый', 10: 'десятый',
      11: 'одиннадцатый', 12: 'двенадцатый', 13: 'тринадцатый', 14: 'четырнадцатый',
      15: 'пятнадцатый', 16: 'шестнадцатый', 17: 'семнадцатый', 18: 'восемнадцатый',
      19: 'девятнадцатый', 20: 'двадцатый'
    };
    if (map[n]) return map[n];
    return spellNumRu(n) + '-й';
  }

  function currencyForms(code) {
    const c = String(code || 'rub').toLowerCase();
    const map = {
      rub: { code: 'RUB', major: ['рубль', 'рубля', 'рублей'], minor: ['копейка', 'копейки', 'копеек'] },
      rur: { code: 'RUB', major: ['рубль', 'рубля', 'рублей'], minor: ['копейка', 'копейки', 'копеек'] },
      usd: { code: 'USD', major: ['доллар', 'доллара', 'долларов'], minor: ['цент', 'цента', 'центов'] },
      eur: { code: 'EUR', major: ['евро', 'евро', 'евро'], minor: ['цент', 'цента', 'центов'] },
      kzt: { code: 'KZT', major: ['тенге', 'тенге', 'тенге'], minor: ['тиын', 'тиына', 'тиынов'] },
      uah: { code: 'UAH', major: ['гривна', 'гривны', 'гривен'], minor: ['копейка', 'копейки', 'копеек'] },
      sum: { code: 'SUM', major: ['сум', 'сума', 'сумов'], minor: ['тийин', 'тийина', 'тийинов'] }
    };
    return map[c] || map.rub;
  }

  function currencyFromArgs(args, fallback) {
    let currency = fallback || 'rub';
    (args || []).forEach((arg) => {
      const s = String(arg || '').trim();
      const m = s.match(/^currency\s*=\s*([a-zA-Z_]+)$/i);
      if (m) currency = m[1];
      else if (/^(rub|rur|usd|eur|kzt|uah|sum)$/i.test(s)) currency = s;
    });
    return currency;
  }

  function moneyModeFromArgs(args) {
    let mode = 'normal';
    (args || []).forEach((arg) => {
      const s = String(arg || '').trim().toLowerCase();
      if (s === 'short' || s === 'normal' || s === 'duplication' || s === 'clarification') mode = s;
      const m = s.match(/^format\s*=\s*(short|normal|duplication|clarification)$/);
      if (m) mode = m[1];
    });
    return mode;
  }

  function moneyToParts(value) {
    const n = Math.round(Math.abs(toCalcNumber(value)) * 100) / 100;
    const major = Math.floor(n);
    const minor = Math.round((n - major) * 100);
    return { sign: toCalcNumber(value) < 0 ? -1 : 1, major: major, minor: minor };
  }

  function moneyNumericString(parts) {
    const sign = parts.sign < 0 ? '-' : '';
    return sign + formatNumber(parts.major + parts.minor / 100, [2, '.', ' ']);
  }

  function spellMoneyRu(value, args, defaultCurrency) {
    const currency = currencyForms(currencyFromArgs(args, defaultCurrency));
    const mode = moneyModeFromArgs(args);
    const parts = moneyToParts(value);
    const sign = parts.sign < 0 ? 'минус ' : '';
    const shortText = moneyNumericString(parts) + ' ' + currency.code;
    const words = sign
      + spellNumRu(parts.major) + ' ' + currency.major[pluralIndex(parts.major)] + ' '
      + pad2(parts.minor) + ' ' + currency.minor[pluralIndex(parts.minor)];
    if (mode === 'short') return shortText;
    if (mode === 'duplication') return shortText + ' (' + words + ')';
    if (mode === 'clarification') return 'сумма прописью: ' + words;
    return words;
  }

  function isEvenValue(value) {
    return Math.abs(Math.floor(toCalcNumber(value))) % 2 === 0 ? '1' : '0';
  }

  function currencyConvertValue(value, args) {
    const currency = String(args[0] || '').trim().toUpperCase();
    const rates = { USD: 90, EUR: 100, BYN: 28, UAH: 2.3, CNY: 12.5, TRY: 3, GBP: 116 };
    const rate = rates[currency];
    if (!rate) return value;
    return String(Math.round((toCalcNumber(value) / rate) * 100) / 100);
  }

  function detectGender(value) {
    const s = String(value || '').trim().toLowerCase();
    if (!s) return '';
    const first = s.split(/\s+/)[0];
    if (/(а|я|ия|на|ла)$/.test(first)) return 'f';
    return 'm';
  }

  function applySpVerb(value, args) {
    const verb = args[0] || '';
    if (!verb) return '';
    if (detectGender(value) === 'f') {
      if (/л$/.test(verb)) return verb + 'а';
      if (/ел$/.test(verb)) return verb.replace(/ел$/, 'ела');
    }
    return verb;
  }

  function firstMeaningfulLetter(value) {
    const m = String(value || '').trim().toLowerCase().match(/[а-яёa-z0-9]/i);
    return m ? m[0] : '';
  }

  function spIn(value) {
    const ch = firstMeaningfulLetter(value);
    return /^[вф]/i.test(ch) ? 'во ' + value : 'в ' + value;
  }

  function spWith(value) {
    const ch = firstMeaningfulLetter(value);
    return /^[сзшж]/i.test(ch) ? 'со ' + value : 'с ' + value;
  }

  function spAbout(value) {
    const ch = firstMeaningfulLetter(value);
    if (/^[аеёиоуыэюя]/i.test(ch)) return 'об ' + value;
    return 'о ' + value;
  }

  function quoteMeta(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function simpleDecl(value) {
    return String(value || '');
  }

  function evalCondition(value, op, compare) {
    const left = String(value == null ? '' : value);
    const right = String(compare == null ? '' : compare);
    const ln = toCalcNumber(left);
    const rn = toCalcNumber(right);
    const o = String(op || '=').toLowerCase();
    if (o === '=' || o === '==') return left === right;
    if (o === '!=' || o === '<>') return left !== right;
    if (o === '>') return ln > rn;
    if (o === '<') return ln < rn;
    if (o === '>=') return ln >= rn;
    if (o === '<=') return ln <= rn;
    if (o === 'in') return right.split('||').map((s) => s.trim()).indexOf(left.trim()) !== -1;
    if (o === 'not in') return right.split('||').map((s) => s.trim()).indexOf(left.trim()) === -1;
    if (o === 'match') return new RegExp(right).test(left);
    if (o === 'not match') return !new RegExp(right).test(left);
    return false;
  }

  function applyEntityModifier(value, modifier, errors) {
    const parsed = parseModifier(modifier);
    const name = parsed.name;
    const args = parsed.args;
    try {
      if (name === 'calc') return safeCalcExpression(value);
      if (name === 'format') return formatNumber(value, args);
      if (name === 'float') return toCalcNumber(value).toFixed(Math.max(0, Number(args[0]) || 0));
      if (name === 'round') {
        const d = Math.max(0, Number(args[0]) || 0);
        const p = Math.pow(10, d);
        return String(Math.round(toCalcNumber(value) * p) / p);
      }
      if (name === 'floor') {
        const d = Math.max(0, Number(args[0]) || 0);
        const p = Math.pow(10, d);
        return String(Math.floor(toCalcNumber(value) * p) / p);
      }
      if (name === 'ceil') {
        const d = Math.max(0, Number(args[0]) || 0);
        const p = Math.pow(10, d);
        return String(Math.ceil(toCalcNumber(value) * p) / p);
      }
      if (name === 'currencyconvert') return currencyConvertValue(value, args);
      if (name === 'iseven') return isEvenValue(value);
      if (name === 'ifempty') return isEmptyValue(value) ? (args[0] || '') : value;
      if (name === 'ifnotempty') return !isEmptyValue(value) ? (args[0] || '') : value;
      if (name === 'if') {
        const ok = evalCondition(value, args[0], args[1]);
        if (ok) return args[2] !== undefined ? args[2] : value;
        return args[3] !== undefined ? args[3] : value;
      }
      if (name === 'df') return formatDate(value, args[0] || 'd.m.Y');
      if (name === 'spell_date') return spellDateRu(value);
      if (name === 'dm') return modifyDate(value, args[0] || 'd.m.Y', args[1] || '');
      if (name === 'date_diff') return formatDateDiff(value, args);
      if (name === 'addworkdays') return addBasicWorkdays(value, Number(args[0]) || 0, args[1] || 'd.m.Y');
      if (name === 'nextworkday') return shiftToBasicWorkday(value, 1, args[0] || 'd.m.Y');
      if (name === 'previousworkday') return shiftToBasicWorkday(value, -1, args[0] || 'd.m.Y');
      if (name === 'isworkday') {
        const d = dateFromValue(value);
        return d && isBasicWorkdayDate(d) ? '1' : '0';
      }
      if (name === 'trim') return String(value || '').trim();
      if (name === 'lwc' || name === 'lower') return String(value || '').toLowerCase();
      if (name === 'upc' || name === 'upper' || name === 'caps') return String(value || '').toUpperCase();
      if (name === 'ucf' || name === 'capitalize') {
        const s = String(value || '');
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
      }
      if (name === 'ucw') return String(value || '').replace(/\b\S/g, (ch) => ch.toUpperCase());
      if (name === 'length') return String(String(value || '').length);
      if (name === 'tonumeric') return String(value || '').replace(/\D+/g, '');
      if (name === 'replace') return args[0] ? String(value || '').split(args[0]).join(args[1] || '') : String(value || '');
      if (name === 'slice') return String(value || '').slice(Number(args[0]) || 0, args[1] !== undefined && args[1] !== '' ? Number(args[1]) : undefined);
      if (name === 'substr') return String(value || '').substr(Number(args[0]) || 0, args[1] !== undefined && args[1] !== '' ? Number(args[1]) : undefined);
      if (name === 'split') {
        const sep = args[0] === 's' ? ' ' : (args[0] || ',');
        const arr = String(value || '').split(sep);
        const idx = args[1] === 'end' ? arr.length - 1 : (Number(args[1]) || 0);
        return arr[idx] != null ? arr[idx] : '';
      }
      if (name === 'pad_left') return String(value || '').padStart(Number(args[0]) || 0, args[1] || ' ');
      if (name === 'pad_right') return String(value || '').padEnd(Number(args[0]) || 0, args[1] || ' ');
      if (name === 'nbr') return String(value || '').replace(/\r?\n/g, '<br>');
      if (name === 'translit') return translitRu(value);
      if (name === 'fio') return applyFio(value, args);
      if (name === 'fio_format') return applyFioFormat(value, args);
      if (name === 'part') return partValue(value, args);
      if (name === 'noun_plur') return nounPlural(value, args);
      if (name === 'spell_num') return spellNumRu(value);
      if (name === 'spell_ordinal' || name === 'ordinal_num') return ordinalNumRu(value);
      if (name === 'spell_money') return spellMoneyRu(value, args, 'rub');
      if (name === 'spell_price') return spellMoneyRu(value, args, 'rub');
      if (name === 'gender') return detectGender(value);
      if (name === 'sp_verb') return applySpVerb(value, args);
      if (name === 'sp_in') return spIn(value);
      if (name === 'sp_with') return spWith(value);
      if (name === 'sp_about') return spAbout(value);
      if (name === 'quotemeta') return quoteMeta(value);
      if (name === 'noun_decl' || name === 'noun_mdecl' || name === 'infl_name' || name === 'infl_geo') return simpleDecl(value);
      errors.push('Модификатор пока не поддерживается: :' + modifier);
      return value;
    } catch (e) {
      errors.push('Ошибка :' + modifier + ' — ' + (e && e.message ? e.message : String(e)));
      return '';
    }
  }

  function applyEntityModifiers(value, chain, errors) {
    return splitModifierChain(chain).reduce((acc, mod) => applyEntityModifier(acc, mod, errors), value);
  }

  function safeCalcExpression(expr) {
    const normalized = String(expr || '').replace(/\s+/g, '').replace(/,/g, '.');
    if (!/^[0-9+\-*/().\s]+$/.test(normalized)) {
      throw new Error('В выражении остались неподдерживаемые символы: ' + expr);
    }
    let pos = 0;
    function skipSpaces() {
      while (/\s/.test(normalized[pos] || '')) pos++;
    }
    function parseNumber() {
      skipSpaces();
      const start = pos;
      while (/[0-9.]/.test(normalized[pos] || '')) pos++;
      if (start === pos) throw new Error('Ожидалось число в выражении: ' + expr);
      const n = Number(normalized.slice(start, pos));
      if (!isFinite(n)) throw new Error('Некорректное число в выражении: ' + expr);
      return n;
    }
    function parseFactor() {
      skipSpaces();
      const ch = normalized[pos];
      if (ch === '+') { pos++; return parseFactor(); }
      if (ch === '-') { pos++; return -parseFactor(); }
      if (ch === '(') {
        pos++;
        const val = parseExpression();
        skipSpaces();
        if (normalized[pos] !== ')') throw new Error('Не закрыта скобка в выражении: ' + expr);
        pos++;
        return val;
      }
      return parseNumber();
    }
    function parseTerm() {
      let val = parseFactor();
      while (true) {
        skipSpaces();
        const op = normalized[pos];
        if (op !== '*' && op !== '/') break;
        pos++;
        const rhs = parseFactor();
        val = op === '*' ? val * rhs : val / rhs;
      }
      return val;
    }
    function parseExpression() {
      let val = parseTerm();
      while (true) {
        skipSpaces();
        const op = normalized[pos];
        if (op !== '+' && op !== '-') break;
        pos++;
        const rhs = parseTerm();
        val = op === '+' ? val + rhs : val - rhs;
      }
      return val;
    }
    const result = parseExpression();
    skipSpaces();
    if (pos < normalized.length) throw new Error('Лишний символ в выражении: ' + normalized[pos]);
    if (!isFinite(result)) throw new Error('Некорректный результат расчёта');
    return result;
  }

  async function replaceAsync(input, regex, replacer) {
    const s = String(input || '');
    let out = '';
    let last = 0;
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(s)) !== null) {
      out += s.slice(last, m.index);
      out += await replacer(m);
      last = regex.lastIndex;
    }
    out += s.slice(last);
    return out;
  }

  async function replaceEntityRefsOnce(text, ctx, vars, errors, cache) {
    let changed = false;
    let out = await replaceAsync(text, /\{\{\s*catalogElement\(([^{}()]+)\s*,\s*(\d+)\)\.cf\((\d+)\)((?::[^{}]+)*)\s*\}\}/g, async (m) => {
      const selector = m[1];
      const catalogId = m[2];
      const fieldId = m[3];
      const chain = m[4] || '';
      const element = await loadCatalogElementForFormula(ctx, selector, catalogId, cache, errors);
      const raw = getCatalogElementFieldValue(element, catalogId, fieldId);
      const value = applyEntityModifiers(raw, chain || '', errors);
      const num = toCalcNumber(value);
      changed = true;
      vars.push({
        token: 'catalogElement(' + selector + ', ' + catalogId + ').cf(' + fieldId + ')' + (chain || ''),
        label: fieldLabelForCatalog(catalogId, fieldId),
        type: fieldTypeForCatalog(catalogId, fieldId),
        raw: raw,
        value: value,
        number: num,
        missingEntity: !element
      });
      return String(value);
    });

    out = await replaceAsync(out, /\{\{\s*(lead|contact|company)\(([^{}()]+)\)\.cfm?\((\d+)\)((?::[^{}]+)*)\s*\}\}/g, async (m) => {
      const root = m[1];
      const entityRefId = m[2];
      const fieldId = m[3];
      const chain = m[4] || '';
      const entity = await loadEntityForFormula(ctx, root, entityRefId, cache, errors);
      const isMulti = m[0].indexOf('.cfm(') !== -1;
      const raw = getEntityFieldValue(entity, fieldId, root, isMulti ? '\n' : ', ');
      const value = applyEntityModifiers(raw, chain || '', errors);
      const num = toCalcNumber(value);
      changed = true;
      vars.push({
        token: root + '(' + entityRefId + ').' + (isMulti ? 'cfm' : 'cf') + '(' + fieldId + ')' + (chain || ''),
        label: fieldLabelForRoot(root, fieldId),
        type: fieldTypeForRoot(root, fieldId),
        raw: raw,
        value: value,
        number: num,
        missingEntity: !entity
      });
      return String(value);
    });

    out = await replaceAsync(out, /\{\{\s*(lead|contact|company)\(([^{}()]+)\)\.([a-zA-Z_][\w]*)(?::([^{}]+))?\s*\}\}/g, async (m) => {
      const root = m[1];
      const entityRefId = m[2];
      const prop = m[3];
      const chain = m[4] || '';
      const entity = await loadEntityForFormula(ctx, root, entityRefId, cache, errors);
      const raw = getEntitySystemValue(entity, root, prop);
      const value = applyEntityModifiers(raw, chain || '', errors);
      const num = toCalcNumber(value);
      changed = true;
      vars.push({
        token: root + '(' + entityRefId + ').' + prop + (chain ? ':' + chain : ''),
        label: root + '(' + entityRefId + ').' + prop,
        raw: raw,
        value: value,
        number: num,
        missingEntity: !entity
      });
      return String(value);
    });

    out = out.replace(/\{\{\s*(lead|contact|company)\.cfm?\((\d+)\)((?::[^{}]+)*)\s*\}\}/g, (m, root, fieldId, chain) => {
      const entity = entityByRoot(ctx, root);
      const isMulti = m.indexOf('.cfm(') !== -1;
      const raw = getEntityFieldValue(entity, fieldId, root, isMulti ? '\n' : ', ');
      const value = applyEntityModifiers(raw, chain || '', errors);
      const num = toCalcNumber(value);
      changed = true;
      vars.push({
        token: root + '.' + (isMulti ? 'cfm' : 'cf') + '(' + fieldId + ')' + (chain || ''),
        label: fieldLabelForRoot(root, fieldId),
        type: fieldTypeForRoot(root, fieldId),
        raw: raw,
        value: value,
        number: num,
        missingEntity: !entity
      });
      return String(value);
    });

    out = out.replace(/\{\{\s*(lead|contact|company)\.([a-zA-Z_][\w]*)(?::([^{}]+))?\s*\}\}/g, (m, root, prop, chain) => {
      const entity = entityByRoot(ctx, root);
      const raw = getEntitySystemValue(entity, root, prop);
      const value = applyEntityModifiers(raw, chain || '', errors);
      const num = toCalcNumber(value);
      changed = true;
      vars.push({
        token: root + '.' + prop + (chain ? ':' + chain : ''),
        label: root + '.' + prop,
        raw: raw,
        value: value,
        number: num,
        missingEntity: !entity
      });
      return String(value);
    });

    out = out.replace(/\{\{\s*date\.now(?::([^{}]+))?\s*\}\}/g, (m, chain) => {
      const raw = Math.floor(Date.now() / 1000);
      const value = applyEntityModifiers(raw, chain || '', errors);
      const num = toCalcNumber(value);
      changed = true;
      vars.push({
        token: 'date.now' + (chain ? ':' + chain : ''),
        label: 'Текущая дата',
        raw: raw,
        value: value,
        number: num,
        missingEntity: false
      });
      return String(value);
    });

    return { text: out, changed: changed };
  }

  async function evaluateEntityCalcTemplate(text, ctx) {
    const vars = [];
    const errors = [];
    const cache = {};
    let substituted = String(text || '');
    for (let i = 0; i < 8; i++) {
      const pass = await replaceEntityRefsOnce(substituted, ctx, vars, errors, cache);
      substituted = pass.text;
      if (!pass.changed) break;
    }

    let calcCount = 0;
    let result = substituted.replace(/\{\{\s*\(([^{}]+)\)\s*:calc((?::[^{}]+)*)\s*\}\}/g, (m, expr, chain) => {
      calcCount++;
      try {
        const value = safeCalcExpression(expr);
        return String(applyEntityModifiers(value, chain || '', errors));
      } catch (e) {
        errors.push(e && e.message ? e.message : String(e));
        return '[calc error]';
      }
    });

    if (!calcCount && /\{\{[^}]*:calc/.test(text || '')) {
      errors.push('Пока поддерживается только формат {{( ... ):calc}}');
    }
    return { result: result, substituted: substituted, vars: vars, errors: errors };
  }

  function countSubstr(source, needle) {
    return (String(source || '').match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  }

  function validateEntityCalcResult(source, res) {
    const errors = [];
    const input = String(source || '');
    if (!input.trim()) errors.push('Введите формулу для проверки.');

    const openCount = countSubstr(input, '{{');
    const closeCount = countSubstr(input, '}}');
    if (openCount !== closeCount) {
      errors.push('Количество открывающих {{ и закрывающих }} скобок не совпадает.');
    }

    (res.errors || []).forEach((e) => errors.push(e));

    const unresolved = String(res.result || '').match(/\{\{[^{}]+\}\}/g) || [];
    unresolved.forEach((token) => errors.push('Не удалось распознать переменную: ' + token));

    if (input.indexOf('{{') !== -1 && !(res.vars || []).length && !unresolved.length) {
      errors.push('Переменные не найдены или формат пока не поддерживается.');
    }

    if (String(res.result || '').indexOf('[calc error]') !== -1) {
      errors.push('Ошибка расчёта :calc. Проверьте арифметическое выражение.');
    }

    return errors;
  }

  function renderEntityCalcResult(text) {
    if (!elements.entityCalcResult) return;
    elements.entityCalcResult.innerHTML = escapeHtml(text || '').replace(/&lt;br&gt;/g, '<br>');
  }

  async function evaluateEntityCalcInput() {
    if (!elements.entityCalcInput || !elements.entityCalcResult) return;
    if (!entityCalcContext) {
      renderEntityCalcResult('Сначала загрузите данные сущности.');
      setEntityCalcErrors(['Сначала нажмите «Проверить», чтобы загрузить данные сущности.']);
      return;
    }
    const source = elements.entityCalcInput.value || '';
    const res = await evaluateEntityCalcTemplate(source, entityCalcContext);
    setEntityCalcErrors(validateEntityCalcResult(source, res));
    renderEntityCalcResult(res.result);
  }

  function syncEntityCalc() {
    if (isEntityCalcActive()) startEntityCalcObserver();
    else {
      stopEntityCalcObserver();
      removeEntityWidgetButton();
      destroyEntityCalcPanel();
    }
  }

  // -------- Sheets export (доп. функция → API разноски) --------
  const SHEETS_EXPORT_COLUMNS = [
    { key: 'date', title: 'Дата' },
    { key: 'contractor', title: 'Контрагент' },
    { key: 'creator_user', title: 'Создатель счета' },
    { key: 'accrual_hours', title: 'Часов к начислению' },
    { key: 'employee_user', title: 'Начислено сотруднику' }
  ];

  function isSheetsExportActive() {
    const featureId = window.F5VRExtras && window.F5VRExtras.FEATURE_SHEETS_EXPORT;
    return window.F5VRExtras
      && featureId
      && window.F5VRExtras.isFeatureEnabled(featureId, state.extras);
  }

  function isSheetsPage() {
    return HOST === '147.45.164.13';
  }

  function sheetsText(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function findSheetsNavHost() {
    const tabTexts = ['Приход компании', 'Разноска по отделу', 'Настройки аккаунта'];
    const tabEls = Array.from(document.querySelectorAll('button, a, div, span')).filter((el) => {
      return tabTexts.indexOf(sheetsText(el)) !== -1;
    });
    for (let i = 0; i < tabEls.length; i++) {
      let node = tabEls[i].parentElement;
      while (node && node !== document.body) {
        const hostText = sheetsText(node);
        const matches = tabTexts.filter((text) => hostText.indexOf(text) !== -1).length;
        if (matches >= 2) return node;
        node = node.parentElement;
      }
    }

    let fallback = document.querySelector('.f5ext-sheets-fallback-host');
    if (!fallback) {
      fallback = document.createElement('div');
      fallback.className = 'f5ext-sheets-fallback-host';
      document.body.appendChild(fallback);
    }
    return fallback;
  }

  function removeSheetsPageButton() {
    document.querySelectorAll('.f5ext-sheets-header-wrap, .f5ext-sheets-tab-wrap, .f5ext-sheets-page-btn').forEach((btn) => {
      try { btn.remove(); } catch (e) {}
    });
    document.querySelectorAll('.f5ext-sheets-fallback-host').forEach((host) => {
      if (!host.children.length) {
        try { host.remove(); } catch (e) {}
      }
    });
  }

  function createSheetsPageButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab f5ext-sheets-page-btn';
    btn.textContent = 'Моя разноска';
    btn.title = 'Получить данные по разноске по выбранному сотруднику';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleSheetsExtract();
    });
    return btn;
  }

  function syncSheetsPageButton() {
    if (!isSheetsExportActive() || !isSheetsPage()) {
      removeSheetsPageButton();
      return;
    }
    ensureStyles();
    const host = findSheetsNavHost();
    if (!host) return;
    const existingWrap = document.querySelector('.f5ext-sheets-header-wrap, .f5ext-sheets-tab-wrap');
    if (existingWrap) {
      if (existingWrap.parentElement === host) return;
      try { existingWrap.remove(); } catch (e) {}
    }
    document.querySelectorAll('.f5ext-sheets-page-btn').forEach((btn) => {
      try { btn.remove(); } catch (e) {}
    });
    const btn = createSheetsPageButton();
    const wrap = document.createElement('div');
    wrap.className = 'tab-with-dropdown f5ext-sheets-header-wrap';
    wrap.appendChild(btn);
    host.appendChild(wrap);
  }

  function scheduleSheetsExportScan() {
    if (!isSheetsExportActive()) return;
    if (sheetsExportScanTimer) clearTimeout(sheetsExportScanTimer);
    sheetsExportScanTimer = setTimeout(() => {
      sheetsExportScanTimer = null;
      syncSheetsPageButton();
    }, 160);
  }

  function startSheetsExportObserver() {
    stopSheetsExportObserver();
    if (!document.body) return;
    ensureStyles();
    syncSheetsPageButton();
    sheetsExportObserver = new MutationObserver(scheduleSheetsExportScan);
    sheetsExportObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopSheetsExportObserver() {
    if (sheetsExportObserver) {
      sheetsExportObserver.disconnect();
      sheetsExportObserver = null;
    }
    if (sheetsExportScanTimer) {
      clearTimeout(sheetsExportScanTimer);
      sheetsExportScanTimer = null;
    }
    removeSheetsPageButton();
  }

  function syncSheetsExport() {
    if (isSheetsExportActive()) startSheetsExportObserver();
    else stopSheetsExportObserver();
  }

  function formatIsoDateRu(value) {
    const s = String(value || '').trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? (m[3] + '.' + m[2] + '.' + m[1]) : s;
  }

  function normalizeSheetsEmployeeName(raw) {
    if (window.F5VRExtras && window.F5VRExtras.normalizeSheetsEmployeeName) {
      return window.F5VRExtras.normalizeSheetsEmployeeName(raw);
    }
    return String(raw || '').replace(/\s+/g, ' ').trim();
  }

  function getSavedSheetsEmployeeName() {
    if (window.F5VRExtras && window.F5VRExtras.getSheetsEmployeeName) {
      return window.F5VRExtras.getSheetsEmployeeName(state.extras);
    }
    const featureId = window.F5VRExtras && window.F5VRExtras.FEATURE_SHEETS_EXPORT;
    const st = featureId && state.extras && state.extras.settings && state.extras.settings[featureId];
    return normalizeSheetsEmployeeName(st && st.employeeName);
  }

  function sheetsEmployeeMatches(actual, expected) {
    const a = normalizeSheetsEmployeeName(actual).toLowerCase();
    const e = normalizeSheetsEmployeeName(expected).toLowerCase();
    return !e || a === e;
  }

  function currentRaznoskaId() {
    const m = location.pathname.match(/\/distdeparts\/(?:all\/)?([^/?#]+)/);
    return m && m[1] && m[1] !== 'pivot' && m[1] !== 'plan' && m[1] !== 'analyze' ? m[1] : '';
  }

  function pageAuthToken() {
    try {
      const fromStorage = localStorage.getItem('token') || sessionStorage.getItem('token');
      if (fromStorage) return fromStorage;
    } catch (e) {}
    const m = String(document.cookie || '').match(/(?:^|;\s*)token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function sheetsApiHeaders() {
    const token = pageAuthToken();
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  function sheetsApiRowToCells(row) {
    return [
      formatIsoDateRu(row && row[1]),
      String((row && row[3]) || '').trim(),
      String((row && row[4]) || '').trim(),
      String((row && row[20]) || '').trim().replace('.', ','),
      String((row && row[21]) || '').trim()
    ];
  }

  async function fetchSheetsApiPage(raznoskaId, page, limit) {
    const id = raznoskaId || currentRaznoskaId();
    if (!id) throw new Error('Не удалось определить id разноски.');
    const url = '/api/raznoskas/' + encodeURIComponent(id)
      + '/data?page=' + encodeURIComponent(page)
      + '&limit=' + encodeURIComponent(limit)
      + '&t=' + Date.now()
      + '&isDepartmentView=true';
    const resp = await fetch(url, { credentials: 'include', headers: sheetsApiHeaders() });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' при загрузке страницы ' + page);
    return resp.json();
  }

  async function extractSheetsRowsFromApi(raznoskaId) {
    const limit = 200;
    const first = await fetchSheetsApiPage(raznoskaId, 1, limit);
    const totalPages = sheetsApiTotalPages(first, limit);
    let rawRows = Array.isArray(first.data) ? first.data.slice() : [];
    for (let page = 2; page <= totalPages; page++) {
      const next = await fetchSheetsApiPage(raznoskaId, page, limit);
      if (next && Array.isArray(next.data)) rawRows = rawRows.concat(next.data);
    }
    return rawRows.map(sheetsApiRowToCells)
      .filter((cells) => cells.some(Boolean));
  }

  async function extractSheetsRows(raznoskaId) {
    return extractSheetsRowsFromApi(raznoskaId);
  }

  function sheetsApiTotalPages(payload, limit) {
    const pagination = payload && payload.pagination ? payload.pagination : {};
    const explicit = Number(
      pagination.totalPages
      || pagination.total_pages
      || pagination.pages
      || pagination.lastPage
      || pagination.last_page
    );
    if (Number.isFinite(explicit) && explicit > 0) return Math.ceil(explicit);
    const total = Number(
      pagination.total
      || pagination.totalItems
      || pagination.total_items
      || pagination.count
    );
    if (Number.isFinite(total) && total > 0 && limit > 0) return Math.max(1, Math.ceil(total / limit));
    return 1;
  }

  async function fetchSheetsRaznoskasPage(page, limit) {
    const url = '/api/raznoskas?page=' + encodeURIComponent(page)
      + '&limit=' + encodeURIComponent(limit);
    const resp = await fetch(url, { credentials: 'include', headers: sheetsApiHeaders() });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' при загрузке списка разносок');
    return resp.json();
  }

  async function fetchSheetsRaznoskas() {
    const limit = 1000;
    const first = await fetchSheetsRaznoskasPage(1, limit);
    const totalPages = sheetsApiTotalPages(first, limit);
    let items = Array.isArray(first.data) ? first.data.slice() : [];
    for (let page = 2; page <= totalPages; page++) {
      const next = await fetchSheetsRaznoskasPage(page, limit);
      if (next && Array.isArray(next.data)) items = items.concat(next.data);
    }
    return items.filter((it) => it && (it.id || it.csvId));
  }

  function sheetsRaznoskaLabel(item) {
    const name = String((item && item.name) || '').trim() || String((item && item.id) || '');
    const count = Number(item && item.rowCount);
    return name + (Number.isFinite(count) ? ' · ' + count + ' строк' : '');
  }

  function latestMonthlySheetsRaznoskas(items, limit) {
    return (items || []).filter((item) => {
      return item
        && item.id
        && Number(item.period_year) > 0
        && Number(item.period_month) >= 1
        && Number(item.period_month) <= 12;
    }).sort((a, b) => {
      const ay = Number(a.period_year) || 0;
      const by = Number(b.period_year) || 0;
      if (ay !== by) return by - ay;
      return (Number(b.period_month) || 0) - (Number(a.period_month) || 0);
    }).slice(0, limit);
  }

  function buildSheetsTsv(rows) {
    const dataRows = rows || [];
    const header = SHEETS_EXPORT_COLUMNS.map((col) => col.title);
    const total = ['', '', 'Итого', formatSheetsHours(sheetsRowsTotalHours(dataRows)), ''];
    return [header].concat(dataRows, dataRows.length ? [total] : []).map((cells) => cells.join('\t')).join('\n');
  }

  function parseSheetsHours(value) {
    const n = Number(String(value || '').replace(/\s+/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }

  function sheetsRowsTotalHours(rows) {
    return (rows || []).reduce((sum, cells) => sum + parseSheetsHours(cells && cells[3]), 0);
  }

  function formatSheetsHours(value) {
    return Number(value || 0).toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function buildSheetsHtmlTable(rows) {
    const head = '<thead><tr>' + SHEETS_EXPORT_COLUMNS.map((col) => '<th>' + escapeHtml(col.title) + '</th>').join('') + '</tr></thead>';
    const body = '<tbody>' + rows.map((cells) => {
      return '<tr>' + cells.map((cell) => '<td>' + escapeHtml(cell) + '</td>').join('') + '</tr>';
    }).join('') + '</tbody>';
    const total = formatSheetsHours(sheetsRowsTotalHours(rows));
    const foot = '<tfoot><tr>'
      + '<td></td><td></td><td>Итого</td><td>' + escapeHtml(total) + '</td><td></td>'
      + '</tr></tfoot>';
    return '<table class="f5ext-sheets-table">' + head + body + foot + '</table>';
  }

  function sheetsPlainTextFromSelection(tableWrap, fallbackText) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return fallbackText;
    const range = sel.getRangeAt(0);
    if (!tableWrap.contains(range.commonAncestorContainer)) return fallbackText;
    const table = tableWrap.querySelector('table.f5ext-sheets-table');
    if (!table) return (sel.toString() || fallbackText).replace(/\u00a0/g, ' ');
    const lines = [];
    table.querySelectorAll('tr').forEach((tr) => {
      const cells = [];
      let rowSelected = false;
      tr.querySelectorAll('th, td').forEach((cell) => {
        if (sel.containsNode(cell, true)) {
          rowSelected = true;
          cells.push((cell.textContent || '').replace(/\u00a0/g, ' ').trim());
        }
      });
      if (rowSelected) lines.push(cells.join('\t'));
    });
    return lines.length ? lines.join('\n') : fallbackText;
  }

  function closeSheetsModal() {
    const el = document.getElementById('f5ext-sheets-modal');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function closeSheetsPicker() {
    const el = document.getElementById('f5ext-sheets-picker');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function closeSheetsRaznoskaPicker() {
    const el = document.getElementById('f5ext-sheets-raznoska-picker');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function closeSheetsLoadingModal() {
    const el = document.getElementById('f5ext-sheets-loading-modal');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function closeSheetsInfoModal() {
    const el = document.getElementById('f5ext-sheets-info-modal');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function openSheetsInfoModal(message) {
    ensureStyles();
    closeSheetsPicker();
    closeSheetsRaznoskaPicker();
    closeSheetsLoadingModal();
    closeSheetsInfoModal();
    const modal = document.createElement('div');
    modal.id = 'f5ext-sheets-info-modal';
    modal.className = 'f5ext-sheets-modal';
    modal.innerHTML = ''
      + '<div class="f5ext-sheets-picker-shell">'
      +   '<div class="f5ext-sheets-head">'
      +     '<div class="f5ext-sheets-title">Данные по разноске</div>'
      +     '<button type="button" class="f5ext-btn-ic js-sheets-info-close" title="Закрыть">×</button>'
      +   '</div>'
      +   '<div class="f5ext-sheets-picker-body">'
      +     '<div class="f5ext-entity-empty">' + escapeHtml(message) + '</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(modal);
    modal.querySelector('.js-sheets-info-close').addEventListener('click', closeSheetsInfoModal);
  }

  function openSheetsLoadingModal() {
    ensureStyles();
    closeSheetsPicker();
    closeSheetsRaznoskaPicker();
    closeSheetsLoadingModal();
    closeSheetsInfoModal();
    const modal = document.createElement('div');
    modal.id = 'f5ext-sheets-loading-modal';
    modal.className = 'f5ext-sheets-modal';
    modal.innerHTML = ''
      + '<div class="f5ext-sheets-picker-shell">'
      +   '<div class="f5ext-sheets-head">'
      +     '<div class="f5ext-sheets-title">Данные по разноске</div>'
      +     '<button type="button" class="f5ext-btn-ic js-sheets-loading-close" title="Закрыть">×</button>'
      +   '</div>'
      +   '<div class="f5ext-sheets-picker-body">'
      +     '<div class="f5ext-sheets-loading" role="status" aria-label="Загрузка"></div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(modal);
    modal.querySelector('.js-sheets-loading-close').addEventListener('click', closeSheetsLoadingModal);
  }

  function openSheetsRaznoskaPicker() {
    ensureStyles();
    closeSheetsPicker();
    closeSheetsRaznoskaPicker();
    closeSheetsLoadingModal();
    closeSheetsInfoModal();
    const modal = document.createElement('div');
    modal.id = 'f5ext-sheets-raznoska-picker';
    modal.className = 'f5ext-sheets-modal';
    modal.innerHTML = ''
      + '<div class="f5ext-sheets-picker-shell">'
      +   '<div class="f5ext-sheets-head">'
      +     '<div class="f5ext-sheets-title">Выберите разноску</div>'
      +     '<button type="button" class="f5ext-btn-ic js-sheets-raznoska-close" title="Закрыть">×</button>'
      +   '</div>'
      +   '<div class="f5ext-sheets-picker-search-wrap">'
      +     '<input type="text" class="f5ext-sheets-picker-search" placeholder="Поиск разноски" autocomplete="off" />'
      +   '</div>'
      +   '<div class="f5ext-sheets-picker-body"></div>'
      + '</div>';
    document.body.appendChild(modal);
    const body = modal.querySelector('.f5ext-sheets-picker-body');
    body.innerHTML = '<div class="f5ext-sheets-loading" role="status" aria-label="Загрузка"></div>';
    function renderRaznoskas(items, query) {
      const q = String(query || '').trim().toLowerCase();
      body.innerHTML = '';
      items.filter((item) => !q || sheetsRaznoskaLabel(item).toLowerCase().indexOf(q) !== -1).forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'f5ext-sheets-employee-btn';
        btn.textContent = sheetsRaznoskaLabel(item);
        btn.addEventListener('click', () => {
          closeSheetsRaznoskaPicker();
          runSheetsExtractForRaznoska(String(item.id || item.csvId || ''));
        });
        body.appendChild(btn);
      });
      if (!body.children.length) {
        body.innerHTML = '<div class="f5ext-entity-empty">Ничего не найдено.</div>';
      }
    }
    const search = modal.querySelector('.f5ext-sheets-picker-search');
    search.disabled = true;
    setTimeout(() => { try { search.focus(); } catch (e) {} }, 0);
    modal.querySelector('.js-sheets-raznoska-close').addEventListener('click', closeSheetsRaznoskaPicker);
    fetchSheetsRaznoskas().then((items) => {
      items = latestMonthlySheetsRaznoskas(items, 5);
      if (!items.length) {
        body.innerHTML = '<div class="f5ext-entity-empty">Не нашёл месячных разносок.</div>';
        return;
      }
      search.disabled = false;
      search.addEventListener('input', () => renderRaznoskas(items, search.value));
      renderRaznoskas(items, '');
    }).catch(() => {
      body.innerHTML = '<div class="f5ext-entity-empty">Не удалось загрузить список разносок.</div>';
    });
  }

  function openSheetsEmployeePicker(initialQuery, preloadedRows, raznoskaId) {
    ensureStyles();
    closeSheetsPicker();
    closeSheetsLoadingModal();
    const modal = document.createElement('div');
    modal.id = 'f5ext-sheets-picker';
    modal.className = 'f5ext-sheets-modal';
    modal.innerHTML = ''
      + '<div class="f5ext-sheets-picker-shell">'
      +   '<div class="f5ext-sheets-head">'
      +     '<div class="f5ext-sheets-title">Выберите сотрудника</div>'
      +     '<button type="button" class="f5ext-btn-ic js-sheets-picker-close" title="Закрыть">×</button>'
      +   '</div>'
      +   '<div class="f5ext-sheets-picker-search-wrap">'
      +     '<input type="text" class="f5ext-sheets-picker-search" placeholder="Поиск сотрудника" autocomplete="off" />'
      +   '</div>'
      +   '<div class="f5ext-sheets-picker-body"></div>'
      + '</div>';
    document.body.appendChild(modal);
    const body = modal.querySelector('.f5ext-sheets-picker-body');
    body.innerHTML = '<div class="f5ext-sheets-loading" role="status" aria-label="Загрузка"></div>';
    function renderNames(names, allRows, query) {
      const q = String(query || '').trim().toLowerCase();
      body.innerHTML = '';
      names.filter((name) => !q || name.toLowerCase().indexOf(q) !== -1).forEach((name) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'f5ext-sheets-employee-btn';
        btn.textContent = name;
        btn.addEventListener('click', () => {
          closeSheetsPicker();
          const rows = allRows.filter((cells) => cells[4] === name);
          openSheetsModal(buildSheetsTsv(rows), rows.length, rows);
        });
        body.appendChild(btn);
      });
      if (!body.children.length) {
        body.innerHTML = '<div class="f5ext-entity-empty">Ничего не найдено.</div>';
      }
    }
    const search = modal.querySelector('.f5ext-sheets-picker-search');
    search.disabled = true;
    setTimeout(() => { try { search.focus(); } catch (e) {} }, 0);
    modal.querySelector('.js-sheets-picker-close').addEventListener('click', closeSheetsPicker);
    const rowsPromise = Array.isArray(preloadedRows) ? Promise.resolve(preloadedRows) : extractSheetsRows(raznoskaId);
    rowsPromise.then((allRows) => {
      const names = Array.from(new Set(allRows.map((cells) => cells[4]).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));
      if (!names.length) {
        body.innerHTML = '<div class="f5ext-entity-empty">Не нашёл сотрудников в разноске.</div>';
        return;
      }
      search.disabled = false;
      search.addEventListener('input', () => renderNames(names, allRows, search.value));
      search.value = normalizeSheetsEmployeeName(initialQuery);
      renderNames(names, allRows, search.value);
    }).catch(() => {
      body.innerHTML = '<div class="f5ext-entity-empty">Не удалось загрузить данные разноски.</div>';
    });
  }

  function openSheetsModal(text, rowCount, rows) {
    ensureStyles();
    closeSheetsModal();
    const modal = document.createElement('div');
    modal.id = 'f5ext-sheets-modal';
    modal.className = 'f5ext-sheets-modal';
    modal.innerHTML = ''
      + '<div class="f5ext-sheets-shell">'
      +   '<div class="f5ext-sheets-head">'
      +     '<div class="f5ext-sheets-title">Данные по разноске <span>' + rowCount + ' строк</span></div>'
      +     '<button type="button" class="f5ext-btn-ic js-sheets-close" title="Закрыть">×</button>'
      +   '</div>'
      +   '<div class="f5ext-sheets-body">'
      +     '<div class="f5ext-sheets-table-wrap" tabindex="0"></div>'
      +     '<div class="f5ext-sheets-actions">'
      +       '<button type="button" class="f5ext-sheets-copy js-sheets-copy">Копировать</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(modal);
    const tableWrap = modal.querySelector('.f5ext-sheets-table-wrap');
    tableWrap.innerHTML = rows && rows.length ? buildSheetsHtmlTable(rows) : '<pre>' + escapeHtml(text) + '</pre>';
    tableWrap.addEventListener('copy', (e) => {
      const plain = sheetsPlainTextFromSelection(tableWrap, text);
      e.preventDefault();
      if (e.clipboardData) e.clipboardData.setData('text/plain', plain);
    });
    tableWrap.focus();
    modal.querySelector('.js-sheets-close').addEventListener('click', closeSheetsModal);
    modal.querySelector('.js-sheets-copy').addEventListener('click', () => {
      const plain = sheetsPlainTextFromSelection(tableWrap, text);
      const done = () => {
        const btn = modal.querySelector('.js-sheets-copy');
        if (!btn) return;
        btn.textContent = 'Скопировано';
        setTimeout(() => { try { btn.textContent = 'Копировать'; } catch (e) {} }, 1400);
      };
      copyToClipboard(plain).then(done);
    });
  }

  function openSheetsResultLoadingModal() {
    ensureStyles();
    closeSheetsModal();
    closeSheetsPicker();
    closeSheetsRaznoskaPicker();
    closeSheetsLoadingModal();
    closeSheetsInfoModal();
    const modal = document.createElement('div');
    modal.id = 'f5ext-sheets-modal';
    modal.className = 'f5ext-sheets-modal';
    modal.innerHTML = ''
      + '<div class="f5ext-sheets-shell">'
      +   '<div class="f5ext-sheets-head">'
      +     '<div class="f5ext-sheets-title">Данные по разноске</div>'
      +     '<button type="button" class="f5ext-btn-ic js-sheets-close" title="Закрыть">×</button>'
      +   '</div>'
      +   '<div class="f5ext-sheets-body">'
      +     '<div class="f5ext-sheets-table-wrap f5ext-sheets-table-loading" tabindex="0">'
      +       '<div class="f5ext-sheets-loading" role="status" aria-label="Загрузка"></div>'
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(modal);
    modal.querySelector('.js-sheets-close').addEventListener('click', closeSheetsModal);
  }

  function runSheetsExtractForRaznoska(raznoskaId) {
    if (!raznoskaId) {
      openSheetsRaznoskaPicker();
      return;
    }
    const savedEmployee = getSavedSheetsEmployeeName();
    if (!savedEmployee) {
      openSheetsEmployeePicker('', null, raznoskaId);
      return;
    }
    let resultLoadingShown = false;
    const resultLoadingTimer = setTimeout(() => {
      resultLoadingShown = true;
      openSheetsResultLoadingModal();
    }, 220);
    extractSheetsRows(raznoskaId).then((allRows) => {
      clearTimeout(resultLoadingTimer);
      const rows = allRows.filter((cells) => sheetsEmployeeMatches(cells[4], savedEmployee));
      if (rows.length) {
        openSheetsModal(buildSheetsTsv(rows), rows.length, rows);
      } else {
        if (resultLoadingShown) closeSheetsModal();
        openSheetsEmployeePicker('', allRows, raznoskaId);
      }
    }).catch(() => {
      clearTimeout(resultLoadingTimer);
      if (resultLoadingShown) closeSheetsModal();
      openSheetsEmployeePicker('', null, raznoskaId);
    });
  }

  function handleSheetsExtract() {
    const id = currentRaznoskaId();
    if (id) runSheetsExtractForRaznoska(id);
    else openSheetsRaznoskaPicker();
    return { ok: true, rows: 0 };
  }

  // -------- Storage --------
  function readStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_DICT_KEY, STORAGE_SETTINGS_KEY, STORAGE_PANEL_RECT_KEY], (raw) => {
        resolve({
          dict: raw[STORAGE_DICT_KEY] || {},
          settings: raw[STORAGE_SETTINGS_KEY] || { panelEnabled: true, hideAmma: false },
          rect: raw[STORAGE_PANEL_RECT_KEY] || null
        });
      });
    });
  }

  function writeDict(allDict) {
    return new Promise((resolve) => {
      const patch = {};
      patch[STORAGE_DICT_KEY] = allDict;
      chrome.storage.local.set(patch, resolve);
    });
  }

  function writeRect(rect) {
    const patch = {};
    patch[STORAGE_PANEL_RECT_KEY] = rect;
    chrome.storage.local.set(patch);
  }

  async function loadStateFromStorage() {
    const { dict, settings } = await readStorage();
    state.panelEnabled = settings.panelEnabled !== false;
    state.hideAmma = !!settings.hideAmma;
    const entry = dict[HOST];
    if (entry) {
      state.fields = entry.fields || {};
      state.fetchedAt = entry.fetchedAt || 0;
      state.counters = entry.counters || state.counters;
      state.errors = entry.errors || [];
    } else {
      state.fields = {};
      state.fetchedAt = 0;
      state.counters = { leads: 0, contacts: 0, companies: 0, catalogs: 0, pipelines: 0, statuses: 0, users: 0, userGroups: 0 };
      state.errors = [];
    }
    rebuildIdIndex();
  }

  async function saveDictForHost() {
    const { dict } = await readStorage();
    dict[HOST] = {
      fields: state.fields,
      fetchedAt: state.fetchedAt,
      counters: state.counters,
      errors: state.errors
    };
    await writeDict(dict);
  }

  // -------- Resolve --------
  function resolveLabel(ref) {
    let key;
    if (ref.entityKey === 'leads' || ref.entityKey === 'contacts' || ref.entityKey === 'companies') {
      key = ref.entityKey + ':' + ref.fieldId;
    } else if (typeof ref.entityKey === 'string' && ref.entityKey.indexOf('catalogs:') === 0) {
      const cid = ref.entityKey.split(':')[1];
      key = 'catalogs:' + cid + ':' + ref.fieldId;
    } else {
      key = '';
    }
    const f = state.fields[key];
    if (!f) return null;
    return { label: f.name, type: f.type || '' };
  }

  // -------- API refresh --------
  async function refreshDictionary() {
    if (refreshing) return { ok: false, error: 'already_running' };
    refreshing = true;
    try {
      const result = await window.F5VRApi.fetchAccountDictionary({
        onProgress: (msg) => {
          try { chrome.runtime.sendMessage({ type: 'F5VR_PROGRESS', host: HOST, message: msg }); } catch (e) {}
        }
      });
      const total = Object.keys(result.fields || {}).length;
      const allFailed = result.errors && result.errors.length >= 4 && total === 0;
      if (allFailed) {
        const has401 = result.errors.some((e) => e.status === 401 || e.status === 403);
        return { ok: false, error: has401 ? 'unauthorized' : 'api_error', errors: result.errors };
      }
      state.fields = result.fields || {};
      state.counters = result.counters || state.counters;
      state.errors = result.errors || [];
      state.fetchedAt = Date.now();
      rebuildIdIndex();
      await saveDictForHost();
      reRenderPreview();
      return { ok: true, counters: state.counters, total: total, errors: state.errors, fetchedAt: state.fetchedAt };
    } catch (e) {
      return { ok: false, error: 'exception', message: e && e.message ? e.message : String(e) };
    } finally {
      refreshing = false;
    }
  }

  // -------- Floating panel UI --------
  const STYLE_ID = 'f5ext-style';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content.css');
    document.head.appendChild(link);
  }

  function clamp(n, min, max) {
    n = Number(n);
    if (!isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function escapeHtml(s) { return window.F5VRParser.escapeHtml(s); }

  function removeOrphanDom() {
    const sel = '#f5ext-launcher-wrap, #f5ext-launcher, #f5ext-panel, #f5ext-vars, #f5ext-ms, #f5ext-entity-calc, .f5ext-entity-widget-btn, .f5ext-tooltip';
    document.querySelectorAll(sel).forEach((n) => {
      try { n.remove(); } catch (e) {}
    });
  }

  function mountPanel() {
    if (panelMounted) return;
    if (!document.body) return;
    if (!state.panelEnabled) return;
    removeOrphanDom();
    panelMounted = true;
    ensureStyles();

    // Лаунчер + hover-фартук с шорткатом «Шаблонизатор» лежат в одном wrapper —
    // так курсор не «теряет» dock при движении между F5 и иконкой {…}.
    const launcherWrap = document.createElement('div');
    launcherWrap.id = 'f5ext-launcher-wrap';
    launcherWrap.className = 'f5ext-launcher-wrap';

    const launcherDock = document.createElement('div');
    launcherDock.className = 'f5ext-launcher-dock';
    launcherDock.innerHTML = ''
      + '<button type="button" class="f5ext-dock-btn" '
      +   'title="Шаблонизатор переменных" aria-label="Шаблонизатор переменных">{…}</button>';

    const btn = document.createElement('div');
    btn.id = 'f5ext-launcher';
    btn.className = 'f5ext-launcher';
    btn.textContent = 'F5';
    btn.title = 'Открыть расшифровщик · наведите для шаблонизатора';

    launcherWrap.appendChild(launcherDock);
    launcherWrap.appendChild(btn);

    elements.launcherDock = launcherDock;

    const panel = document.createElement('div');
    panel.id = 'f5ext-panel';
    panel.className = 'f5ext-panel';
    panel.innerHTML = ''
      + '<div class="f5ext-panel-shell">'
      +   '<div class="f5ext-resize" data-dir="n"></div>'
      +   '<div class="f5ext-resize" data-dir="s"></div>'
      +   '<div class="f5ext-resize" data-dir="e"></div>'
      +   '<div class="f5ext-resize" data-dir="w"></div>'
      +   '<div class="f5ext-resize" data-dir="ne"></div>'
      +   '<div class="f5ext-resize" data-dir="nw"></div>'
      +   '<div class="f5ext-resize" data-dir="se"></div>'
      +   '<div class="f5ext-resize" data-dir="sw"></div>'
      +   '<div class="f5ext-panel-wrap">'
      +     '<div class="f5ext-panel-clip">'
      +       '<div class="f5ext-panel-head">'
      +         '<div class="f5ext-panel-title">F5 — Расшифровка переменных <span class="f5ext-panel-ver"></span></div>'
      +         '<div class="f5ext-panel-actions">'
      +           '<button type="button" class="f5ext-btn-ic js-vars-toggle" title="Шаблонизатор переменных">{…}</button>'
      +           '<button type="button" class="f5ext-btn-ic js-refresh" title="Обновить словарь">⟳</button>'
      +           '<button type="button" class="f5ext-btn-ic js-close" title="Закрыть">×</button>'
      +         '</div>'
      +       '</div>'
      +       '<div class="f5ext-panel-body">'
      +         '<textarea class="f5ext-input" placeholder="Вставьте сюда текст с переменными — он расшифруется ниже. Переменные из шаблонизатора копируются в буфер обмена."></textarea>'
      +         '<div class="f5ext-preview"><div class="f5ext-preview-head">Предпросмотр</div><div class="f5ext-preview-body"></div></div>'
      +         '<div class="f5ext-modpanel" aria-live="polite">'
      +           '<div class="f5ext-modpanel-head">'
      +             '<div class="f5ext-modpanel-title"></div>'
      +             '<button type="button" class="f5ext-btn-ic js-close-mod" title="Закрыть">×</button>'
      +           '</div>'
      +           '<div class="f5ext-modpanel-body"></div>'
      +         '</div>'
      +         '<div class="f5ext-status js-status"></div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    const vars = document.createElement('div');
    vars.id = 'f5ext-vars';
    vars.className = 'f5ext-vars';
    vars.innerHTML = ''
      + '<div class="f5ext-vars-shell">'
      +   '<div class="f5ext-resize" data-dir="n"></div>'
      +   '<div class="f5ext-resize" data-dir="s"></div>'
      +   '<div class="f5ext-resize" data-dir="e"></div>'
      +   '<div class="f5ext-resize" data-dir="w"></div>'
      +   '<div class="f5ext-resize" data-dir="ne"></div>'
      +   '<div class="f5ext-resize" data-dir="nw"></div>'
      +   '<div class="f5ext-resize" data-dir="se"></div>'
      +   '<div class="f5ext-resize" data-dir="sw"></div>'
      +   '<div class="f5ext-vars-clip">'
      +     '<div class="f5ext-vars-head">'
      +       '<div class="f5ext-vars-title">Переменные</div>'
      +       '<div class="f5ext-vars-actions">'
      +         '<button type="button" class="f5ext-btn-ic js-vars-close" title="Закрыть">×</button>'
      +       '</div>'
      +     '</div>'
      +     '<div class="f5ext-vars-body">'
      +       '<div class="f5ext-vars-tabs" role="tablist"></div>'
      +       '<div class="f5ext-vars-hint" hidden></div>'
      +       '<input type="text" class="f5ext-vars-search" placeholder="Найти…">'
      +       '<div class="f5ext-vars-list" tabindex="0"></div>'
      +       '<div class="f5ext-vars-foot">'
      +         '<label class="f5ext-vars-modlabel">Модификатор:'
      +           '<select class="f5ext-vars-mod"></select>'
      +         '</label>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    document.body.appendChild(launcherWrap);
    document.body.appendChild(panel);
    document.body.appendChild(vars);

    elements.btn = btn;
    elements.launcherWrap = launcherWrap;
    elements.dockBtn = launcherDock.querySelector('.f5ext-dock-btn');
    elements.panel = panel;
    elements.input = panel.querySelector('.f5ext-input');
    elements.preview = panel.querySelector('.f5ext-preview-body');
    elements.modPanel = panel.querySelector('.f5ext-modpanel');
    elements.status = panel.querySelector('.js-status');
    elements.vars = vars;
    elements.varsList = vars.querySelector('.f5ext-vars-list');
    elements.varsSearch = vars.querySelector('.f5ext-vars-search');
    elements.varsModSel = vars.querySelector('.f5ext-vars-mod');
    elements.varsTabs = vars.querySelector('.f5ext-vars-tabs');
    elements.varsHint = vars.querySelector('.f5ext-vars-hint');

    try {
      const v = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
      const verEl = panel.querySelector('.f5ext-panel-ver');
      if (v && verEl) verEl.textContent = 'v' + v;
    } catch (_) { /* noop */ }

    const tip = document.createElement('div');
    tip.className = 'f5ext-tooltip';
    document.documentElement.appendChild(tip);
    elements.tip = tip;

    bindLauncher();
    mountMsDockButton();
    syncMinesweeper();
    bindHeaderActions();
    bindDragAndResize();
    bindInputAndPreview();
    bindPreviewEvents();
    bindVarsPanel();
    bindFrontFocus();

    chrome.storage.local.get(STORAGE_PANEL_RECT_KEY, (raw) => {
      if (!panelMounted) return;
      const rect = raw && raw[STORAGE_PANEL_RECT_KEY];
      if (!rect || !elements.panel || !elements.panel.isConnected) return;
      elements.panel.style.width = clamp(rect.w, 360, window.innerWidth * 0.92) + 'px';
      elements.panel.style.height = clamp(rect.h, 280, window.innerHeight * 0.88) + 'px';
      elements.panel.style.left = clamp(rect.x, 8, window.innerWidth - 80) + 'px';
      elements.panel.style.top = clamp(rect.y, 8, window.innerHeight - 60) + 'px';
      elements.panel.style.right = 'auto';
      elements.panel.style.bottom = 'auto';
    });
  }

  function unmountPanel() {
    if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }
    try { if (elements.launcherWrap && elements.launcherWrap.parentNode) elements.launcherWrap.parentNode.removeChild(elements.launcherWrap); } catch (e) {}
    try { if (elements.panel && elements.panel.parentNode) elements.panel.parentNode.removeChild(elements.panel); } catch (e) {}
    try { if (elements.vars && elements.vars.parentNode) elements.vars.parentNode.removeChild(elements.vars); } catch (e) {}
    destroyMinesweeperPanel();
    destroyEntityCalcPanel();
    removeEntityWidgetButton();
    elements.msDockBtn = null;
    try { if (elements.tip && elements.tip.parentNode) elements.tip.parentNode.removeChild(elements.tip); } catch (e) {}
    elements = createEmptyElements();
    panelMounted = false;
    varsUserSized = false;
    removeOrphanDom();
  }

  function applyPanelEnabled() {
    if (!isAmoLikeHost()) {
      if (panelMounted) unmountPanel();
      else removeOrphanDom();
      return;
    }
    if (state.panelEnabled && !panelMounted) mountPanel();
    else if (!state.panelEnabled && panelMounted) unmountPanel();
    else if (!state.panelEnabled) removeOrphanDom();
  }

  // Скрытие/возврат кнопки «Открыть чат с Аммой» и её всплывающих подсказок
  // («С этой сделкой что-то не так…») через CSS-инъекцию. Стабильные маркеры —
  // aria-label у кнопки лаунчера и svg-иконка amma_chat--cross-close у подсказок.
  // Применяется без MutationObserver — правило само цепляет новые узлы в DOM.
  const AMMA_STYLE_ID = 'f5ext-amma-hide';
  const AMMA_HIDE_CSS = ''
    + 'button[aria-label*="Аммой" i],'
    + 'button[aria-label*="Amma" i],'
    + 'a[aria-label*="Аммой" i],'
    + 'a[aria-label*="Amma" i],'
    // Только прямой контейнер подсказки (div > div > button > svg-крестик).
    // Широкий div:has(.svg-...) матчит корень amoCRM и белит всю страницу.
    + 'div:has(> div > button .svg-amma_chat--cross-close-dims) {'
    +   'display: none !important;'
    + '}';

  function applyAmmaHidden() {
    const existing = document.getElementById(AMMA_STYLE_ID);
    if (!isAmoLikeHost()) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (state.hideAmma) {
      if (existing) {
        existing.textContent = AMMA_HIDE_CSS;
        return;
      }
      const style = document.createElement('style');
      style.id = AMMA_STYLE_ID;
      style.textContent = AMMA_HIDE_CSS;
      (document.head || document.documentElement).appendChild(style);
    } else if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    syncCatDance();
  }

  function setStatus(msg, kind) {
    if (!elements.status) return;
    elements.status.classList.remove('is-ok', 'is-err', 'is-progress');
    if (kind) elements.status.classList.add(kind);
    elements.status.textContent = msg || '';
  }

  // ---------------------------------------------------------------------------
  // Z-index «как у обычных окон»: то, что трогали последним — всегда сверху.
  // Оба окна имеют одинаковый базовый z-index в CSS; активному добавляется класс
  // is-front, который поднимает его над неактивным.
  // ---------------------------------------------------------------------------
  function bringToFront(el) {
    if (!el) return;
    if (elements.panel) elements.panel.classList.remove('is-front');
    if (elements.vars) elements.vars.classList.remove('is-front');
    if (elements.ms) elements.ms.classList.remove('is-front');
    if (elements.entityCalc) elements.entityCalc.classList.remove('is-front');
    el.classList.add('is-front');
  }

  function bindFrontFocus() {
    if (elements.panel) {
      elements.panel.addEventListener('mousedown', () => bringToFront(elements.panel), true);
    }
    if (elements.vars) {
      elements.vars.addEventListener('mousedown', () => bringToFront(elements.vars), true);
    }
  }

  // ---------------------------------------------------------------------------
  // Лаунчер F5 + hover-«фартук»
  //   • Клик по самой F5 → toggle расшифровщика.
  //   • Hover на F5 (или на фартук) → выезжает кнопка {…} для шаблонизатора.
  //   • Клик по {…} → toggle шаблонизатора, активная иконка подсвечивается.
  // ---------------------------------------------------------------------------
  let dockHideTimer = null;
  const DOCK_HIDE_DELAY_MS = 220;

  function showLauncherDock() {
    if (!elements.launcherWrap) return;
    if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }
    elements.launcherWrap.classList.add('is-hover');
  }
  function hideLauncherDockSoon() {
    if (!elements.launcherWrap) return;
    if (dockHideTimer) clearTimeout(dockHideTimer);
    dockHideTimer = setTimeout(() => {
      dockHideTimer = null;
      if (elements.launcherWrap) elements.launcherWrap.classList.remove('is-hover');
    }, DOCK_HIDE_DELAY_MS);
  }

  function syncDockState() {
    const open = isVarsOpen();
    if (elements.dockBtn) elements.dockBtn.classList.toggle('is-active', open);
    if (elements.msDockBtn) elements.msDockBtn.classList.toggle('is-active', isMsOpen());
    // Ту же подсветку используем и для кнопки «{…}» в шапке расшифровщика —
    // чтобы пользователь сразу видел, открыт ли уже шаблонизатор.
    if (elements.panel) {
      const headerBtn = elements.panel.querySelector('.js-vars-toggle');
      if (headerBtn) headerBtn.classList.toggle('is-active', open);
    }
  }

  function bindLauncher() {
    elements.btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      togglePanel();
    });

    if (elements.dockBtn) {
      elements.dockBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleVarsPanel();
      });
    }

    if (elements.launcherWrap) {
      elements.launcherWrap.addEventListener('mouseenter', showLauncherDock);
      elements.launcherWrap.addEventListener('mouseleave', hideLauncherDockSoon);
      // На случай быстрых событий focusin/focusout (клавиатурная навигация).
      elements.launcherWrap.addEventListener('focusin',  showLauncherDock);
      elements.launcherWrap.addEventListener('focusout', (focusEvent) => {
        // Скрываем dock только если фокус ушёл за пределы wrap'а.
        const next = focusEvent.relatedTarget;
        if (!next || !elements.launcherWrap.contains(next)) hideLauncherDockSoon();
      });
    }

    syncDockState();
  }

  function openPanel() {
    elements.panel.classList.add('is-open');
    if (elements.btn) elements.btn.classList.add('is-active');
    bringToFront(elements.panel);
    setTimeout(() => { try { elements.input.focus(); } catch (e) {} }, 0);
  }
  function closePanel() {
    elements.panel.classList.remove('is-open');
    if (elements.btn) elements.btn.classList.remove('is-active');
    if (elements.tip) elements.tip.classList.remove('is-open');
    if (elements.modPanel) elements.modPanel.classList.remove('is-open');
    // Шаблонизатор живёт независимо и не закрывается вместе с расшифровщиком.
  }
  function togglePanel() {
    if (elements.panel.classList.contains('is-open')) closePanel();
    else openPanel();
  }

  function bindHeaderActions() {
    elements.panel.querySelector('.js-close').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); closePanel();
    });
    elements.panel.querySelector('.js-close-mod').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); elements.modPanel.classList.remove('is-open');
    });
    elements.panel.querySelector('.js-vars-toggle').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); toggleVarsPanel();
    });
    elements.panel.querySelector('.js-refresh').addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      setStatus('Обновляю словарь…', 'is-progress');
      const r = await refreshDictionary();
      if (r && r.ok) {
        setStatus('Готово: ' + r.total + ' полей', 'is-ok');
        if (isVarsOpen()) renderVars();
      }
      else if (r && r.error === 'unauthorized') setStatus('Не авторизованы в амо. Войдите и попробуйте снова.', 'is-err');
      else if (r && r.error === 'already_running') setStatus('Уже идёт обновление…', 'is-progress');
      else setStatus('Не удалось обновить словарь', 'is-err');
    });
  }

  function bindDragAndResize() {
    const panel = elements.panel;
    const head = panel.querySelector('.f5ext-panel-head');
    const drag = { active: false, dx: 0, dy: 0 };
    head.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('.f5ext-btn-ic, .f5ext-resize')) return;
      if (e.button !== 0) return;
      const r = panel.getBoundingClientRect();
      drag.active = true;
      drag.dx = e.clientX - r.left;
      drag.dy = e.clientY - r.top;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag.active) return;
      const w = panel.offsetWidth || 460;
      const h = panel.offsetHeight || 360;
      const x = clamp(e.clientX - drag.dx, 6, window.innerWidth - Math.max(60, w - 40));
      const y = clamp(e.clientY - drag.dy, 6, window.innerHeight - Math.max(60, h - 40));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!drag.active) return;
      drag.active = false;
      const rr = panel.getBoundingClientRect();
      writeRect({ x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) });
    });

    const rs = { active: false, dir: '', sx: 0, sy: 0, start: null };
    function getMM() {
      return {
        minW: 360, minH: 280,
        maxW: Math.floor(window.innerWidth * 0.92),
        maxH: Math.floor(window.innerHeight * 0.88)
      };
    }
    panel.querySelectorAll('.f5ext-resize').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const r = panel.getBoundingClientRect();
        rs.active = true;
        rs.dir = handle.getAttribute('data-dir') || '';
        rs.sx = e.clientX; rs.sy = e.clientY;
        rs.start = { left: r.left, top: r.top, width: r.width, height: r.height };
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = r.left + 'px';
        panel.style.top = r.top + 'px';
        panel.style.width = r.width + 'px';
        panel.style.height = r.height + 'px';
        e.preventDefault();
        e.stopPropagation();
      });
    });
    document.addEventListener('mousemove', (e) => {
      if (!rs.active || !rs.start) return;
      const dx = e.clientX - rs.sx;
      const dy = e.clientY - rs.sy;
      const dir = rs.dir;
      const r0 = rs.start;
      const mm = getMM();
      let left = r0.left, top = r0.top, w = r0.width, h = r0.height;
      if (dir.indexOf('e') !== -1) w = r0.width + dx;
      if (dir.indexOf('s') !== -1) h = r0.height + dy;
      if (dir.indexOf('w') !== -1) { w = r0.width - dx; left = r0.left + dx; }
      if (dir.indexOf('n') !== -1) { h = r0.height - dy; top = r0.top + dy; }
      w = clamp(w, mm.minW, mm.maxW);
      h = clamp(h, mm.minH, mm.maxH);
      left = clamp(left, 6, window.innerWidth - Math.max(60, w - 10));
      top = clamp(top, 6, window.innerHeight - Math.max(60, h - 10));
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
      panel.style.width = Math.round(w) + 'px';
      panel.style.height = Math.round(h) + 'px';
      if (isVarsOpen()) syncVarsHeight();
    });
    document.addEventListener('mouseup', () => {
      if (!rs.active) return;
      rs.active = false;
      const rr = panel.getBoundingClientRect();
      writeRect({ x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) });
      if (isVarsOpen()) syncVarsHeight();
    });
  }

  let _renderTimer = null;
  function debouncedRender() {
    if (_renderTimer) clearTimeout(_renderTimer);
    _renderTimer = setTimeout(reRenderPreview, 280);
  }

  function reRenderPreview() {
    if (!elements.input || !elements.preview) return;
    const text = elements.input.value || '';
    const opts = { idIndex: state.idIndex || {} };
    const refs = window.F5VRParser.extractFieldRefs(text, opts);
    elements.preview.innerHTML = window.F5VRParser.renderMirrorHtml(text, refs, resolveLabel, opts);
  }

  function bindInputAndPreview() {
    elements.input.addEventListener('input', debouncedRender);
    elements.input.addEventListener('change', reRenderPreview);
  }

  function positionTip(x, y) {
    const t = elements.tip;
    const w = t.offsetWidth || 260;
    const h = t.offsetHeight || 80;
    const pad = 12;
    const left = Math.min(window.innerWidth - w - pad, Math.max(pad, x + 14));
    const top = Math.min(window.innerHeight - h - pad, Math.max(pad, y + 14));
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }

  function showVarTip(target, x, y) {
    const t = elements.tip;
    const original = target.getAttribute('data-original') || target.textContent;
    const entity = target.getAttribute('data-entity') || '';
    const fieldId = target.getAttribute('data-field-id') || '';
    const label = target.getAttribute('data-label') || '';
    const type = target.getAttribute('data-type') || '';
    const isResolved = target.classList.contains('is-resolved');
    const entityRu = window.F5VRParser.entityLabel(entity);

    let extra = '';
    if (entity === 'statuses') {
      const f = state.fields['statuses:' + fieldId];
      if (f && f.pipelineName) extra = ' · воронка «' + f.pipelineName + '»';
    } else if (entity === 'pipelines') {
      const f = state.fields['pipelines:' + fieldId];
      if (f && f.is_main) extra = ' · основная';
    }

    const titleText = isResolved
      ? label
      : (entity === 'pipelines' ? 'Воронка id ' + fieldId
         : entity === 'statuses' ? 'Этап id ' + fieldId
         : 'Поле id ' + fieldId);
    const sub = entityRu + (fieldId ? ' · id ' + fieldId : '') + (type ? ' · ' + type : '') + extra;
    const ago = state.fetchedAt ? ' (обновлено ' + new Date(state.fetchedAt).toLocaleString('ru-RU', { hour12: false }) + ')' : '';
    const foot = isResolved
      ? '<div class="f5ext-tt-foot">Источник: API amoCRM' + escapeHtml(ago) + '</div>'
      : '<div class="f5ext-tt-foot">Нет в словаре. Нажмите ⟳, чтобы обновить.</div>';
    t.innerHTML = ''
      + '<div class="f5ext-tt-title">' + escapeHtml(titleText) + '</div>'
      + '<div class="f5ext-tt-sub">' + escapeHtml(sub) + '</div>'
      + '<div class="f5ext-tt-ex">' + escapeHtml(original) + '</div>'
      + foot;
    t.classList.add('is-open');
    positionTip(x, y);
  }

  function sysRootLabel(root) {
    if (root === 'lead') return 'Сделка';
    if (root === 'contact') return 'Контакт';
    if (root === 'company') return 'Компания';
    if (root === 'client') return 'Клиент';
    if (root === 'date') return 'Дата/время';
    if (root === 'users' || root === 'user') return 'Пользователь amoCRM';
    if (root === 'random') return 'Случайные значения';
    return root;
  }

  function showSysVarTip(target, x, y) {
    const t = elements.tip;
    const root = target.getAttribute('data-root') || '';
    const path = target.getAttribute('data-path') || '';
    const args = target.getAttribute('data-args') || '';
    const original = target.getAttribute('data-original') || target.textContent;
    const desc = target.getAttribute('data-desc') || '';
    const example = target.getAttribute('data-example') || '';
    const isKnown = target.classList.contains('is-known');
    const head = root + '.' + path + (args || '');
    const rootRu = sysRootLabel(root);
    let body = '';
    if (isKnown) {
      body += '<div class="f5ext-tt-row"><div class="f5ext-tt-key">Описание</div><div class="f5ext-tt-val">' + escapeHtml(desc) + '</div></div>';
      if (example) {
        body += '<div class="f5ext-tt-row"><div class="f5ext-tt-key">Пример</div><div class="f5ext-tt-ex">' + escapeHtml(example) + '</div></div>';
      }
    } else {
      body = '<div class="f5ext-tt-foot">Системная переменная без описания в справочнике. Проверьте написание или см. cmdf5.ru/manual/vars.</div>';
    }
    t.innerHTML = ''
      + '<div class="f5ext-tt-title">' + escapeHtml(head) + '</div>'
      + '<div class="f5ext-tt-sub">' + escapeHtml(rootRu + ' · системная переменная') + '</div>'
      + '<div class="f5ext-tt-ex">' + escapeHtml(original) + '</div>'
      + body;
    t.classList.add('is-open');
    positionTip(x, y);
  }

  function showIdHintTip(target, x, y) {
    const t = elements.tip;
    const id = target.getAttribute('data-id') || '';
    const original = target.getAttribute('data-original') || target.textContent || id;
    const candidates = collectIdCandidates(id);
    let body = '';
    if (!candidates.length) {
      body = '<div class="f5ext-tt-foot">ID нет в словаре. Нажмите ⟳, чтобы обновить.</div>';
    } else {
      candidates.forEach((c) => {
        const ent = window.F5VRParser.entityLabel(c.entityKey);
        const typeRu = c.type && c.entityKey !== 'users' && c.entityKey !== 'usersGroups'
          ? window.F5VRParser.fieldTypeLabel(c.type) : '';
        let line = ent + ' · «' + c.name + '»';
        if (typeRu) line += ' · ' + typeRu;
        if (c.pipelineName) line += ' · воронка «' + c.pipelineName + '»';
        if (c.entityKey === 'users') {
          if (c.email) line += ' · ' + c.email;
          if (c.groupName) line += ' · группа «' + c.groupName + '»';
          if (c.isAdmin) line += ' · админ';
          if (c.isActive === false) line += ' · неактивен';
        }
        body += '<div class="f5ext-tt-row"><div class="f5ext-tt-val">' + escapeHtml(line) + '</div></div>';
      });
    }
    t.innerHTML = ''
      + '<div class="f5ext-tt-title">' + escapeHtml('ID ' + id) + '</div>'
      + '<div class="f5ext-tt-sub">Найдено в словаре домена</div>'
      + (original && original !== id ? '<div class="f5ext-tt-ex">' + escapeHtml(original) + '</div>' : '')
      + body;
    t.classList.add('is-open');
    positionTip(x, y);
  }

  function showModTip(target, x, y) {
    const t = elements.tip;
    const name = target.getAttribute('data-mod') || '';
    const args = target.getAttribute('data-args') || '';
    const help = window.F5VRParser.getModifierHelp(name);
    const head = ':' + name + (args || '');
    let body = '';
    if (help) {
      body += '<div class="f5ext-tt-row"><div class="f5ext-tt-key">Описание</div><div class="f5ext-tt-val">' + escapeHtml(help.desc) + '</div></div>';
      if (help.examples && help.examples.length) {
        body += '<div class="f5ext-tt-row"><div class="f5ext-tt-key">Примеры</div>';
        help.examples.slice(0, 3).forEach((ex) => {
          body += '<div class="f5ext-tt-ex">' + escapeHtml(ex) + '</div>';
        });
        body += '</div>';
      }
    } else {
      body = '<div class="f5ext-tt-foot">Неизвестный модификатор. Проверьте написание.</div>';
    }
    t.innerHTML = '<div class="f5ext-tt-title">' + escapeHtml(head) + '</div>' + body;
    t.classList.add('is-open');
    positionTip(x, y);
  }

  function buildVarInnerHtml(original) {
    const opts = { idIndex: state.idIndex || {} };
    const refs = window.F5VRParser.extractFieldRefs(original, opts);
    if (!refs.length) return escapeHtml(original);
    const tmp = document.createElement('div');
    tmp.innerHTML = window.F5VRParser.renderMirrorHtml(original, refs, () => null, opts);
    const inner = tmp.querySelector('.f5ext-var');
    return inner ? inner.innerHTML : escapeHtml(original);
  }

  function buildSysInnerHtml(original) {
    const opts = { idIndex: state.idIndex || {} };
    const refs = window.F5VRParser.extractFieldRefs(original, opts);
    if (!refs.length) return escapeHtml(original);
    const tmp = document.createElement('div');
    tmp.innerHTML = window.F5VRParser.renderMirrorHtml(original, refs, () => null, opts);
    const inner = tmp.querySelector('.f5ext-sysvar');
    return inner ? inner.innerHTML : escapeHtml(original);
  }

  function toggleSysExpansion(v) {
    const expanded = v.getAttribute('data-expanded') === '1';
    if (!expanded) {
      const desc = v.getAttribute('data-desc') || '';
      if (!desc) return;
      v.setAttribute('data-expanded', '1');
      v.classList.add('is-expanded');
      v.textContent = '{' + desc + '}';
    } else {
      const original = v.getAttribute('data-original') || '';
      v.setAttribute('data-expanded', '0');
      v.classList.remove('is-expanded');
      v.innerHTML = buildSysInnerHtml(original);
    }
  }

  function toggleVarExpansion(v) {
    const expanded = v.getAttribute('data-expanded') === '1';
    if (!expanded) {
      const label = v.getAttribute('data-label') || '';
      if (!label) return;
      const type = v.getAttribute('data-type') || '';
      const entityRu = window.F5VRParser.entityLabel(v.getAttribute('data-entity') || '');
      v.setAttribute('data-expanded', '1');
      v.classList.add('is-expanded');
      v.textContent = '{' + entityRu + ': ' + label + (type ? ' (' + type + ')' : '') + '}';
    } else {
      const original = v.getAttribute('data-original') || '';
      v.setAttribute('data-expanded', '0');
      v.classList.remove('is-expanded');
      v.innerHTML = buildVarInnerHtml(original);
    }
  }

  function showModifierPanel(target) {
    const name = target.getAttribute('data-mod') || '';
    const args = target.getAttribute('data-args') || '';
    const help = window.F5VRParser.getModifierHelp(name);
    const $body = elements.modPanel.querySelector('.f5ext-modpanel-body');
    elements.modPanel.querySelector('.f5ext-modpanel-title').textContent = ':' + name + (args || '');
    $body.innerHTML = '';
    if (help) {
      const d = document.createElement('div');
      d.className = 'f5ext-modpanel-desc';
      d.textContent = help.desc;
      $body.appendChild(d);
      if (help.examples && help.examples.length) {
        const eh = document.createElement('div');
        eh.className = 'f5ext-modpanel-exhead';
        eh.textContent = 'Примеры';
        $body.appendChild(eh);
        help.examples.slice(0, 3).forEach((ex) => {
          const ed = document.createElement('div');
          ed.className = 'f5ext-modpanel-ex';
          ed.textContent = ex;
          $body.appendChild(ed);
        });
      }
    } else {
      const d = document.createElement('div');
      d.className = 'f5ext-modpanel-foot';
      d.textContent = 'Неизвестный модификатор. Проверьте написание.';
      $body.appendChild(d);
    }
    elements.modPanel.classList.add('is-open');
  }

  // -------- Vars (templater) panel --------

  function getVarsState() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_VARS_KEY, (raw) => {
        resolve(raw[STORAGE_VARS_KEY] || { open: false, x: null, y: null, activeGroup: 'all' });
      });
    });
  }
  function saveVarsState(patch) {
    chrome.storage.local.get(STORAGE_VARS_KEY, (raw) => {
      const prev = raw[STORAGE_VARS_KEY] || {};
      const next = Object.assign({}, prev, patch);
      const obj = {};
      obj[STORAGE_VARS_KEY] = next;
      chrome.storage.local.set(obj);
    });
  }
  function isVarsOpen() {
    return !!(elements.vars && elements.vars.classList.contains('is-open'));
  }

  const VARS_GROUPS = [
    { id: 'all',      label: 'Все' },
    { id: 'lead',     label: 'Сделка' },
    { id: 'contact',  label: 'Контакт' },
    { id: 'company',  label: 'Компания' },
    { id: 'client',   label: 'Клиент' },
    { id: 'pipeline', label: 'Воронки' },
    { id: 'catalog',  label: 'Каталоги' },
    { id: 'date',     label: 'Дата' },
    { id: 'user',     label: 'Пользователь' },
    { id: 'random',   label: 'Случайное' }
  ];

  function groupOf(entityKey) {
    if (entityKey === 'leads' || entityKey === 'lead') return 'lead';
    if (entityKey === 'contacts' || entityKey === 'contact') return 'contact';
    if (entityKey === 'companies' || entityKey === 'company') return 'company';
    if (entityKey === 'client') return 'client';
    if (entityKey === 'date') return 'date';
    if (entityKey === 'users' || entityKey === 'user' || entityKey === 'usersGroups') return 'user';
    if (entityKey === 'random') return 'random';
    if (entityKey === 'pipelines' || entityKey === 'statuses') return 'pipeline';
    if (typeof entityKey === 'string' && entityKey.indexOf('catalogs:') === 0) return 'catalog';
    return 'other';
  }

  function entityShortLabel(entityKeyOrRoot) {
    if (entityKeyOrRoot === 'leads' || entityKeyOrRoot === 'lead') return 'Сделка';
    if (entityKeyOrRoot === 'contacts' || entityKeyOrRoot === 'contact') return 'Контакт';
    if (entityKeyOrRoot === 'companies' || entityKeyOrRoot === 'company') return 'Компания';
    if (entityKeyOrRoot === 'client') return 'Клиент';
    if (entityKeyOrRoot === 'date') return 'Дата';
    if (entityKeyOrRoot === 'users' || entityKeyOrRoot === 'user') return 'Пользователь';
    if (entityKeyOrRoot === 'usersGroups') return 'Группа';
    if (entityKeyOrRoot === 'random') return 'Случайное';
    if (entityKeyOrRoot === 'pipelines') return 'Воронка';
    if (entityKeyOrRoot === 'statuses') return 'Этап';
    if (typeof entityKeyOrRoot === 'string' && entityKeyOrRoot.indexOf('catalogs:') === 0) {
      return 'Каталог ' + (entityKeyOrRoot.split(':')[1] || '');
    }
    return entityKeyOrRoot || '';
  }

  // Кэш переменных для одного цикла рендера (сбрасывается перед каждым renderVars()).
  let _varsCache = null;
  function getAllVars() {
    if (!_varsCache) _varsCache = buildAllVars();
    return _varsCache;
  }
  function invalidateVarsCache() { _varsCache = null; }

  function buildAllVars() {
    const items = [];
    const fields = state.fields || {};
    for (const key in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      const f = fields[key];
      const parts = key.split(':');
      let entityKey, fieldId, insert, kind = 'cf', desc = '';
      if (parts.length === 2) {
        entityKey = parts[0];
        fieldId = parts[1];
        if (entityKey === 'pipelines') {
          // У воронок нет отдельной переменной в шаблонизаторе F5 —
          // id используется как аргумент в contact.leadsCount/company.leadsCount и т.п.
          insert = fieldId;
          kind = 'idref';
          desc = (f.is_main ? 'Основная воронка. ' : '') + 'ID: ' + fieldId
            + '. Используется как аргумент, например: {{contact.leadsCount(' + fieldId + '/)}}.';
        } else if (entityKey === 'statuses') {
          insert = fieldId;
          kind = 'idref';
          const argEx = (f.pipelineId ? f.pipelineId + '/' : '') + fieldId;
          desc = (f.pipelineName ? 'Воронка: «' + f.pipelineName + '». ' : '') + 'ID: ' + fieldId
            + '. Используется как аргумент, например: {{contact.leadsCount(' + argEx + ')}}.';
        } else if (entityKey === 'users') {
          // ID пользователя amoCRM; в шаблонах подставляется аргументом
          // в системные переменные {{users(<id>).name}}, {{users(<id>).group_id}} и т. п.
          insert = fieldId;
          kind = 'idref';
          const adminMark = f.isAdmin ? ' • админ' : '';
          const inactiveMark = f.isActive === false ? ' • деактивирован' : '';
          const groupPart = f.groupName ? ' Группа: «' + f.groupName + '».' : '';
          const emailPart = f.email ? ' E-mail: ' + f.email + '.' : '';
          desc = 'ID пользователя: ' + fieldId + adminMark + inactiveMark + '.'
            + emailPart + groupPart
            + ' Используется аргументом, например: {{users(' + fieldId + ').name}}.';
        } else if (entityKey === 'usersGroups') {
          // ID группы (отдела). Возвращается через {{users(<id>).group_id}}
          // и используется в фильтрах задач/сделок по ответственному.
          insert = fieldId;
          kind = 'idref';
          desc = 'ID группы пользователей: ' + fieldId
            + '. Возвращается через {{users(<id>).group_id}}; имя — через {{users(<id>).group_name}}.';
        } else {
          const root = entityKey === 'leads' ? 'lead' : entityKey === 'contacts' ? 'contact' : 'company';
          insert = '{{' + root + '.cf(' + fieldId + ')}}';
        }
      } else if (parts.length === 3 && parts[0] === 'catalogs') {
        entityKey = 'catalogs:' + parts[1];
        fieldId = parts[2];
        insert = '{{catalogElement(first, ' + parts[1] + ').cf(' + fieldId + ')}}';
      } else {
        continue;
      }
      items.push({
        kind: kind,
        name: f.name || ('Поле ' + fieldId),
        type: f.type || '',
        entityKey: entityKey,
        fieldId: fieldId,
        canonical: insert.replace(/^\{\{|\}\}$/g, ''),
        insert: insert,
        desc: desc,
        example: '',
        pipelineName: f.pipelineName || '',
        pipelineId: f.pipelineId != null ? String(f.pipelineId) : '',
        sort: f.sort || 0,
        isMain: !!f.is_main,
        groupId: f.groupId != null ? String(f.groupId) : '',
        groupName: f.groupName || '',
        email: f.email || '',
        isAdmin: !!f.isAdmin,
        isActive: f.isActive !== false
      });
    }
    const sys = window.F5VRParser.listSystemVars ? window.F5VRParser.listSystemVars() : [];
    for (let i = 0; i < sys.length; i++) {
      const s = sys[i];
      items.push({
        kind: 'system',
        name: s.canonical,
        entityKey: s.rootEntity,
        canonical: s.canonical,
        insert: s.insert,
        desc: s.desc,
        example: s.example
      });
    }
    items.sort((a, b) => {
      const ka = entityShortLabel(a.entityKey) + ' ' + (a.name || '').toLowerCase();
      const kb = entityShortLabel(b.entityKey) + ' ' + (b.name || '').toLowerCase();
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return items;
  }

  function computeGroupCounts(items) {
    const counts = { all: items.length };
    for (let i = 0; i < items.length; i++) {
      const g = groupOf(items[i].entityKey);
      counts[g] = (counts[g] || 0) + 1;
    }
    return counts;
  }

  function renderVarsTabs() {
    if (!elements.varsTabs) return;
    const items = getAllVars();
    const counts = computeGroupCounts(items);
    if (activeVarsGroup !== 'all' && !counts[activeVarsGroup]) {
      activeVarsGroup = 'all';
      saveVarsState({ activeGroup: 'all' });
    }
    const frag = document.createDocumentFragment();
    for (let i = 0; i < VARS_GROUPS.length; i++) {
      const g = VARS_GROUPS[i];
      const c = counts[g.id] || 0;
      if (g.id !== 'all' && c === 0) continue;
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'f5ext-vars-tab' + (activeVarsGroup === g.id ? ' is-active' : '');
      t.dataset.group = g.id;
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', activeVarsGroup === g.id ? 'true' : 'false');
      t.innerHTML = '<span class="f5ext-vars-tab-label">' + escapeHtml(g.label) + '</span>'
        + '<span class="f5ext-vars-tab-count">' + c + '</span>';
      frag.appendChild(t);
    }
    elements.varsTabs.innerHTML = '';
    elements.varsTabs.appendChild(frag);
  }

  // Создаёт DOM-строку для одной переменной шаблонизатора.
  function makeVarRow(it, options) {
    options = options || {};
    const row = document.createElement('div');
    let rowKindCls = ' is-cf';
    if (it.kind === 'system') rowKindCls = ' is-system';
    else if (it.kind === 'idref') rowKindCls = ' is-idref';
    // Заголовок «родителя» (воронка / группа пользователей) и его «потомки».
    if (options.headerForPipeline || options.headerForGroup) rowKindCls += ' is-pipeline-header';
    if (options.statusChild || options.userChild) rowKindCls += ' is-status-child';
    row.className = 'f5ext-vars-row' + rowKindCls;
    row.dataset.insert = it.insert;
    row.dataset.canonical = it.canonical;
    if (it.desc) row.title = it.desc + (it.example ? '\n\nПример: ' + it.example : '');
    const left = document.createElement('div');
    left.className = 'f5ext-vars-row-left';
    if (options.headerForPipeline) {
      left.innerHTML = 'Воронка: <b>«' + escapeHtml(it.name) + '»</b>'
        + (it.isMain ? ' <span class="f5ext-vars-row-mainbadge">основная</span>' : '');
    } else if (options.headerForGroup) {
      left.innerHTML = 'Группа: <b>«' + escapeHtml(it.name) + '»</b>';
    } else if (it.entityKey === 'users') {
      let label = escapeHtml(it.name);
      if (it.isAdmin) label += ' <span class="f5ext-vars-row-mainbadge">админ</span>';
      if (it.isActive === false) label += ' <span class="f5ext-vars-row-mainbadge">неактивен</span>';
      left.innerHTML = label;
    } else {
      left.textContent = it.name;
    }
    const right = document.createElement('div');
    right.className = 'f5ext-vars-row-right';
    if (it.kind === 'idref') {
      let entLabel = entityShortLabel(it.entityKey);
      if (options.showPipelineForStatus && it.entityKey === 'statuses' && it.pipelineName) {
        entLabel = 'Этап · ' + it.pipelineName;
      } else if (options.showGroupForUser && it.entityKey === 'users' && it.groupName) {
        entLabel = 'Польз. · ' + it.groupName;
      }
      right.innerHTML = '<span class="f5ext-vars-row-badge">ID</span>'
        + '<span class="f5ext-vars-row-ent">' + escapeHtml(entLabel) + '</span>';
    } else {
      right.textContent = entityShortLabel(it.entityKey);
    }
    row.appendChild(left);
    row.appendChild(right);
    return row;
  }

  // Группированный рендер для вкладки «Воронки»: воронка-заголовок + её этапы под ней.
  function renderPipelinesGrouped(items, frag) {
    const pipelines = [];
    const statusesByPipeline = {};
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.entityKey === 'pipelines') {
        pipelines.push(it);
      } else if (it.entityKey === 'statuses') {
        const pid = it.pipelineId || '';
        (statusesByPipeline[pid] = statusesByPipeline[pid] || []).push(it);
      }
    }
    pipelines.sort((a, b) => (a.sort - b.sort) || (a.name || '').localeCompare(b.name || '', 'ru'));
    Object.keys(statusesByPipeline).forEach((pid) => {
      statusesByPipeline[pid].sort((a, b) => (a.sort - b.sort) || (a.name || '').localeCompare(b.name || '', 'ru'));
    });
    let shown = 0;
    for (let i = 0; i < pipelines.length; i++) {
      const p = pipelines[i];
      frag.appendChild(makeVarRow(p, { headerForPipeline: true }));
      shown++;
      const statuses = statusesByPipeline[p.fieldId] || [];
      for (let j = 0; j < statuses.length; j++) {
        frag.appendChild(makeVarRow(statuses[j], { statusChild: true }));
        shown++;
      }
    }
    // Этапы, у которых не нашлось воронки (на всякий случай).
    const orphanStatuses = statusesByPipeline[''] || [];
    if (orphanStatuses.length) {
      orphanStatuses.forEach((s) => {
        frag.appendChild(makeVarRow(s, { showPipelineForStatus: true }));
        shown++;
      });
    }
    return shown;
  }

  // Группированный рендер для вкладки «Пользователь»:
  //   1) Системные переменные про пользователя сверху (kind=system) — плоско.
  //   2) Группы пользователей как «родитель», их участники под каждой — как «потомки».
  //   3) Юзеры без сматчившейся группы — отдельной секцией «Без группы».
  function renderUsersGrouped(items, frag) {
    const systemItems = [];
    const groups = [];
    const usersByGroup = {};
    const orphanUsers = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.entityKey === 'usersGroups') {
        groups.push(it);
      } else if (it.entityKey === 'users') {
        if (it.groupId) {
          (usersByGroup[it.groupId] = usersByGroup[it.groupId] || []).push(it);
        } else {
          orphanUsers.push(it);
        }
      } else {
        systemItems.push(it);
      }
    }

    systemItems.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
    groups.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
    Object.keys(usersByGroup).forEach((gid) => {
      usersByGroup[gid].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
    });
    orphanUsers.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));

    let shown = 0;
    for (let i = 0; i < systemItems.length; i++) {
      frag.appendChild(makeVarRow(systemItems[i]));
      shown++;
    }
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      frag.appendChild(makeVarRow(g, { headerForGroup: true }));
      shown++;
      const users = usersByGroup[g.fieldId] || [];
      for (let j = 0; j < users.length; j++) {
        frag.appendChild(makeVarRow(users[j], { userChild: true }));
        shown++;
      }
      delete usersByGroup[g.fieldId];
    }
    // Юзеры с group_id, для которых группа не загружена.
    const leftoverGroupIds = Object.keys(usersByGroup);
    for (let i = 0; i < leftoverGroupIds.length; i++) {
      const list = usersByGroup[leftoverGroupIds[i]] || [];
      for (let j = 0; j < list.length; j++) {
        frag.appendChild(makeVarRow(list[j], { showGroupForUser: true }));
        shown++;
      }
    }
    if (orphanUsers.length) {
      // Разделитель «Без группы» использует тот же стиль заголовка-родителя,
      // что и воронка/группа, — это некликабельный текст, поэтому собираем
      // div вручную (а не через makeVarRow, которому нужен валидный insert).
      const sep = document.createElement('div');
      sep.className = 'f5ext-vars-row is-pipeline-header';
      sep.innerHTML = '<div class="f5ext-vars-row-left">Без группы</div>'
        + '<div class="f5ext-vars-row-right"></div>';
      frag.appendChild(sep);
      shown++;
      for (let i = 0; i < orphanUsers.length; i++) {
        frag.appendChild(makeVarRow(orphanUsers[i], { userChild: true }));
        shown++;
      }
    }
    return shown;
  }

  function renderVarsList() {
    if (!elements.varsList) return;
    const q = (elements.varsSearch && elements.varsSearch.value || '').trim().toLowerCase();
    const items = getAllVars();
    const frag = document.createDocumentFragment();
    let shown = 0;

    // Спец-режим: вкладка «Воронки» без поиска — группированный вид (воронка → этапы).
    if (activeVarsGroup === 'pipeline' && !q) {
      const pipelineItems = items.filter((it) => groupOf(it.entityKey) === 'pipeline');
      shown = renderPipelinesGrouped(pipelineItems, frag);
    } else if (activeVarsGroup === 'user' && !q) {
      // Спец-режим: вкладка «Пользователь» без поиска — системные сверху
      // плоско, ниже группы пользователей с участниками внутри.
      const userItems = items.filter((it) => groupOf(it.entityKey) === 'user');
      shown = renderUsersGrouped(userItems, frag);
    } else {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (activeVarsGroup !== 'all' && groupOf(it.entityKey) !== activeVarsGroup) continue;
        const hay = ((it.name || '') + ' ' + (it.canonical || '') + ' '
          + (it.desc || '') + ' ' + (it.pipelineName || '') + ' '
          + (it.groupName || '') + ' ' + (it.email || '')).toLowerCase();
        if (q && hay.indexOf(q) === -1) continue;
        frag.appendChild(makeVarRow(it, { showPipelineForStatus: true, showGroupForUser: true }));
        shown++;
      }
    }

    elements.varsList.innerHTML = '';
    if (!shown) {
      const empty = document.createElement('div');
      empty.className = 'f5ext-vars-empty';
      if (!Object.keys(state.fields || {}).length && activeVarsGroup !== 'all'
          && (activeVarsGroup === 'lead' || activeVarsGroup === 'contact' || activeVarsGroup === 'company' || activeVarsGroup === 'catalog')) {
        empty.textContent = 'Словарь пуст. Нажмите ⟳ в шапке для загрузки полей с amoCRM.';
      } else if (!Object.keys(state.fields || {}).length && activeVarsGroup === 'all') {
        empty.textContent = 'Кастомные поля ещё не загружены. Нажмите ⟳ в шапке.';
      } else if (q) {
        empty.textContent = 'Ничего не найдено.';
      } else {
        empty.textContent = 'Нет переменных в этой вкладке.';
      }
      elements.varsList.appendChild(empty);
    } else {
      elements.varsList.appendChild(frag);
    }
  }

  function renderVarsHint() {
    if (!elements.varsHint) return;
    if (activeVarsGroup === 'pipeline') {
      elements.varsHint.hidden = false;
      elements.varsHint.innerHTML = ''
        + 'У воронок и этапов нет отдельной переменной — клик копирует <b>ID</b>. '
        + 'Используйте как аргумент, например: '
        + '<code>{{contact.leadsCount(id_воронки/id_этапа)}}</code>.';
    } else if (activeVarsGroup === 'user') {
      elements.varsHint.hidden = false;
      elements.varsHint.innerHTML = ''
        + 'У пользователей и групп нет отдельной переменной — клик копирует <b>ID</b>. '
        + 'Используйте как аргумент, например: '
        + '<code>{{users(id_пользователя).name}}</code>. '
        + 'Список пользователей доступен только администраторам аккаунта.';
    } else {
      elements.varsHint.hidden = true;
      elements.varsHint.innerHTML = '';
    }
  }

  function renderVars() {
    invalidateVarsCache();
    renderVarsTabs();
    renderVarsHint();
    renderVarsList();
  }

  function fillModSelect() {
    const sel = elements.varsModSel;
    if (!sel || !window.F5VRParser || !window.F5VRParser.listModifierPresets) return;
    sel.innerHTML = '';
    const groups = window.F5VRParser.listModifierPresets();
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      const parent = grp.group
        ? (function () {
            const og = document.createElement('optgroup');
            og.label = grp.group;
            sel.appendChild(og);
            return og;
          })()
        : sel;
      for (let i = 0; i < grp.items.length; i++) {
        const o = document.createElement('option');
        o.value = grp.items[i].value;
        o.textContent = grp.items[i].label;
        parent.appendChild(o);
      }
    }
  }

  function applyModifierToInsert(insertText) {
    const mod = (elements.varsModSel && elements.varsModSel.value) || '';
    if (!mod) return insertText;
    if (insertText.length >= 4 && insertText.slice(-2) === '}}' && insertText.slice(0, 2) === '{{') {
      return insertText.slice(0, -2) + ':' + mod + '}}';
    }
    return insertText;
  }

  function copyToClipboard(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }
  function flashRowCopied(row) {
    if (!row) return;
    row.classList.add('is-copied');
    setTimeout(() => { try { row.classList.remove('is-copied'); } catch (e) {} }, 700);
  }

  function syncVarsHeight() {
    if (!elements.vars) return;
    if (varsUserSized) return;
    // Если расшифровщик открыт — подгоняем высоту под него; иначе — фиксированная.
    const panelOpen = elements.panel && elements.panel.classList.contains('is-open');
    if (panelOpen) {
      const r = elements.panel.getBoundingClientRect();
      if (r.height > 0) {
        elements.vars.style.height = Math.round(r.height) + 'px';
        return;
      }
    }
    elements.vars.style.height = '420px';
  }

  function defaultVarsRect() {
    const w = 300;
    const gap = 8;
    const panelOpen = elements.panel && elements.panel.classList.contains('is-open');
    if (panelOpen) {
      const main = elements.panel.getBoundingClientRect();
      let x = Math.round(main.left - w - gap);
      if (x < 8) x = 8;
      return { x: x, y: Math.round(main.top), w: w };
    }
    // Расшифровщик закрыт — становимся в правый нижний угол, не закрывая лаунчер.
    const launcherReserveX = 70;
    const launcherReserveY = 70;
    const x = Math.max(8, window.innerWidth - w - launcherReserveX);
    const y = Math.max(8, window.innerHeight - 420 - launcherReserveY);
    return { x: x, y: y, w: w };
  }

  function openVarsPanel() {
    if (!elements.vars) return;
    elements.vars.classList.add('is-open');
    bringToFront(elements.vars);
    getVarsState().then((s) => {
      const def = defaultVarsRect();
      const userSized = !!(s && s.userSized);
      varsUserSized = userSized;
      const maxW = Math.floor(window.innerWidth * 0.7);
      const maxH = Math.floor(window.innerHeight * 0.95);
      const w = userSized && s.w ? clamp(s.w, 240, maxW) : 300;
      elements.vars.style.width = w + 'px';
      if (userSized && s.h) {
        elements.vars.style.height = clamp(s.h, 240, maxH) + 'px';
      } else {
        syncVarsHeight();
      }
      const x = clamp((s && s.x != null) ? s.x : def.x, 6, window.innerWidth - 80);
      const y = clamp((s && s.y != null) ? s.y : def.y, 6, window.innerHeight - 60);
      elements.vars.style.left = x + 'px';
      elements.vars.style.top = y + 'px';
      elements.vars.style.right = 'auto';
      elements.vars.style.bottom = 'auto';
    });
    renderVars();
    saveVarsState({ open: true });
    syncDockState();
    setTimeout(() => { try { elements.varsSearch.focus(); } catch (e) {} }, 0);
  }
  function closeVarsPanel() {
    if (!elements.vars) return;
    elements.vars.classList.remove('is-open');
    saveVarsState({ open: false });
    syncDockState();
  }
  function toggleVarsPanel() {
    if (isVarsOpen()) closeVarsPanel();
    else openVarsPanel();
  }

  function bindVarsResize() {
    const vars = elements.vars;
    const handles = vars.querySelectorAll('.f5ext-resize');
    const rs = { active: false, dir: '', sx: 0, sy: 0, start: null };
    function getMM() {
      return {
        minW: 240, minH: 240,
        maxW: Math.floor(window.innerWidth * 0.7),
        maxH: Math.floor(window.innerHeight * 0.95)
      };
    }
    handles.forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const r = vars.getBoundingClientRect();
        rs.active = true;
        rs.dir = handle.getAttribute('data-dir') || '';
        rs.sx = e.clientX; rs.sy = e.clientY;
        rs.start = { left: r.left, top: r.top, width: r.width, height: r.height };
        vars.style.right = 'auto';
        vars.style.bottom = 'auto';
        vars.style.left = r.left + 'px';
        vars.style.top = r.top + 'px';
        vars.style.width = r.width + 'px';
        vars.style.height = r.height + 'px';
        e.preventDefault();
        e.stopPropagation();
      });
    });
    document.addEventListener('mousemove', (e) => {
      if (!rs.active || !rs.start) return;
      const dx = e.clientX - rs.sx;
      const dy = e.clientY - rs.sy;
      const dir = rs.dir;
      const r0 = rs.start;
      const mm = getMM();
      let left = r0.left, top = r0.top, w = r0.width, h = r0.height;
      if (dir.indexOf('e') !== -1) w = r0.width + dx;
      if (dir.indexOf('s') !== -1) h = r0.height + dy;
      if (dir.indexOf('w') !== -1) { w = r0.width - dx; left = r0.left + dx; }
      if (dir.indexOf('n') !== -1) { h = r0.height - dy; top = r0.top + dy; }
      w = clamp(w, mm.minW, mm.maxW);
      h = clamp(h, mm.minH, mm.maxH);
      left = clamp(left, 6, window.innerWidth - Math.max(60, w - 10));
      top = clamp(top, 6, window.innerHeight - Math.max(60, h - 10));
      vars.style.left = Math.round(left) + 'px';
      vars.style.top = Math.round(top) + 'px';
      vars.style.width = Math.round(w) + 'px';
      vars.style.height = Math.round(h) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!rs.active) return;
      rs.active = false;
      varsUserSized = true;
      const rr = vars.getBoundingClientRect();
      saveVarsState({
        x: Math.round(rr.left),
        y: Math.round(rr.top),
        w: Math.round(rr.width),
        h: Math.round(rr.height),
        userSized: true
      });
    });
  }

  function bindVarsPanel() {
    fillModSelect();

    elements.vars.querySelector('.js-vars-close').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); closeVarsPanel();
    });

    elements.varsSearch.addEventListener('input', renderVarsList);

    elements.varsModSel.addEventListener('change', () => {
      saveVarsState({ modifier: elements.varsModSel.value });
    });

    elements.varsTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.f5ext-vars-tab');
      if (!tab) return;
      e.preventDefault(); e.stopPropagation();
      const g = tab.dataset.group || 'all';
      if (g === activeVarsGroup) return;
      activeVarsGroup = g;
      saveVarsState({ activeGroup: g });
      renderVarsTabs();
      renderVarsHint();
      renderVarsList();
    });

    elements.varsList.addEventListener('click', (e) => {
      const row = e.target.closest('.f5ext-vars-row');
      if (!row) return;
      e.preventDefault(); e.stopPropagation();
      const insert = row.dataset.insert || '';
      if (!insert) return;
      const finalText = applyModifierToInsert(insert);
      copyToClipboard(finalText).then((ok) => {
        if (ok) {
          flashRowCopied(row);
          setStatus('Скопировано: ' + finalText, 'is-ok');
        } else {
          setStatus('Не удалось скопировать. Скопируйте вручную: ' + finalText, 'is-err');
        }
      });
    });

    const head = elements.vars.querySelector('.f5ext-vars-head');
    const drag = { active: false, dx: 0, dy: 0 };
    head.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('.f5ext-btn-ic, .f5ext-resize')) return;
      if (e.button !== 0) return;
      const r = elements.vars.getBoundingClientRect();
      drag.active = true;
      drag.dx = e.clientX - r.left;
      drag.dy = e.clientY - r.top;
      elements.vars.style.right = 'auto';
      elements.vars.style.bottom = 'auto';
      elements.vars.style.left = r.left + 'px';
      elements.vars.style.top = r.top + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag.active) return;
      const w = elements.vars.offsetWidth || 300;
      const h = elements.vars.offsetHeight || 400;
      const x = clamp(e.clientX - drag.dx, 6, window.innerWidth - Math.max(60, w - 40));
      const y = clamp(e.clientY - drag.dy, 6, window.innerHeight - Math.max(60, h - 40));
      elements.vars.style.left = x + 'px';
      elements.vars.style.top = y + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!drag.active) return;
      drag.active = false;
      const rr = elements.vars.getBoundingClientRect();
      saveVarsState({ x: Math.round(rr.left), y: Math.round(rr.top) });
    });

    bindVarsResize();

    window.addEventListener('resize', () => { if (isVarsOpen()) syncVarsHeight(); });

    getVarsState().then((s) => {
      if (!s) return;
      if (s.modifier && elements.varsModSel) {
        // Браузер сам игнорирует значение, если такой опции нет.
        elements.varsModSel.value = s.modifier;
      }
      if (typeof s.activeGroup === 'string') activeVarsGroup = s.activeGroup;
      if (s.userSized) varsUserSized = true;
      renderVarsTabs();
    });
  }

  function bindPreviewEvents() {
    const preview = elements.preview;
    const tip = elements.tip;

    preview.addEventListener('mouseover', (e) => {
      const idh = e.target.closest('.f5ext-idhint');
      const v = e.target.closest('.f5ext-var');
      const sv = e.target.closest('.f5ext-sysvar');
      const m = e.target.closest('.f5ext-mod');
      // Наведение прямо на цифру ID всегда показывает, что это за объект —
      // даже внутри уже распознанной переменной (например, id воронки в leadsCount(<id>/...)).
      if (idh) { showIdHintTip(idh, e.clientX, e.clientY); return; }
      if (v) { showVarTip(v, e.clientX, e.clientY); return; }
      if (sv) { showSysVarTip(sv, e.clientX, e.clientY); return; }
      if (m) { showModTip(m, e.clientX, e.clientY); }
    });
    preview.addEventListener('mousemove', (e) => {
      if (!tip.classList.contains('is-open')) return;
      const within = e.target.closest('.f5ext-var, .f5ext-sysvar, .f5ext-mod, .f5ext-idhint');
      if (!within) tip.classList.remove('is-open');
      else positionTip(e.clientX, e.clientY);
    });
    preview.addEventListener('mouseleave', () => { tip.classList.remove('is-open'); });

    preview.addEventListener('click', (e) => {
      const v = e.target.closest('.f5ext-var');
      if (v) {
        e.preventDefault(); e.stopPropagation();
        toggleVarExpansion(v);
        return;
      }
      const sv = e.target.closest('.f5ext-sysvar');
      if (sv) {
        e.preventDefault(); e.stopPropagation();
        toggleSysExpansion(sv);
        return;
      }
      const m = e.target.closest('.f5ext-mod');
      if (m) {
        e.preventDefault(); e.stopPropagation();
        showModifierPanel(m);
      }
    });
  }

  // -------- Storage change reactivity --------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_DICT_KEY] || changes[STORAGE_SETTINGS_KEY]) {
      loadStateFromStorage().then(() => {
        applyPanelEnabled();
        applyAmmaHidden();
        reRenderPreview();
        if (isVarsOpen()) renderVars();
      });
    }
    if (window.F5VRExtras && changes[window.F5VRExtras.STORAGE_EXTRAS_KEY]) {
      loadExtrasFromStorage().then(() => {
        applyExtrasFeatures();
        if (isMsOpen() && isMinesweeperActive()) startMsGame();
      });
    }
  });

  // -------- Messaging --------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'F5VR_PING') { sendResponse({ ok: true, host: HOST }); return false; }
    if (msg.type === 'F5VR_REFRESH') {
      refreshDictionary().then((res) => sendResponse(res));
      return true;
    }
    if (msg.type === 'F5VR_OPEN_PANEL') {
      if (!panelMounted) mountPanel();
      if (panelMounted && elements.panel) openPanel();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'F5VR_TOGGLE_PANEL_ENABLED') {
      state.panelEnabled = !!msg.enabled;
      applyPanelEnabled();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'F5VR_TOGGLE_AMMA_HIDDEN') {
      state.hideAmma = !!msg.hidden;
      applyAmmaHidden();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'F5VR_EXTRAS_CHANGED') {
      loadExtrasFromStorage().then(() => {
        revertAllCatDanceHints();
        applyExtrasFeatures();
        if (isMsOpen() && isMinesweeperActive()) startMsGame();
        sendResponse({ ok: true });
      });
      return true;
    }
    if (msg.type === 'F5VR_CLEAR_HOST') {
      readStorage().then(({ dict }) => {
        delete dict[HOST];
        writeDict(dict).then(() => {
          state.fields = {};
          state.fetchedAt = 0;
          state.counters = { leads: 0, contacts: 0, companies: 0, catalogs: 0, pipelines: 0, statuses: 0, users: 0, userGroups: 0 };
          state.errors = [];
          rebuildIdIndex();
          reRenderPreview();
          if (isVarsOpen()) renderVars();
          sendResponse({ ok: true });
        });
      });
      return true;
    }
    return false;
  });

  // -------- Init --------
  function init() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }
    loadStateFromStorage().then(() => loadExtrasFromStorage()).then(() => {
      applyPanelEnabled();
      applyAmmaHidden();
      applyExtrasFeatures();
      const stale = !state.fetchedAt || (Date.now() - state.fetchedAt) > TTL_MS;
      if (isAmoLikeHost() && stale) setTimeout(() => { refreshDictionary(); }, 1500);
    });
  }
  init();
})();
