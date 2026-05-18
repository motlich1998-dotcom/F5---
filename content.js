'use strict';

(function () {
  if (window.__F5VR_CONTENT_LOADED__) return;
  window.__F5VR_CONTENT_LOADED__ = true;

  try { if (window.top !== window) return; } catch (e) { return; }

  const STORAGE_DICT_KEY = 'f5vr:dict';
  const STORAGE_SETTINGS_KEY = 'f5vr:settings';
  const STORAGE_PANEL_RECT_KEY = 'f5vr:panel_rect';
  const STORAGE_VARS_KEY = 'f5vr:vars_panel';
  const TTL_MS = 24 * 3600 * 1000;
  const HOST = location.hostname;
  if (!HOST) return;

  const state = {
    fields: {},
    fetchedAt: 0,
    counters: { leads: 0, contacts: 0, companies: 0, catalogs: 0, pipelines: 0, statuses: 0, users: 0, userGroups: 0 },
    errors: [],
    panelEnabled: true,
    hideAmma: false,
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
      btn: null, launcherWrap: null, dockBtn: null,
      panel: null, input: null, preview: null,
      modPanel: null, status: null, tip: null,
      vars: null, varsList: null, varsSearch: null, varsModSel: null, varsTabs: null, varsHint: null
    };
  }
  let activeVarsGroup = 'all';
  let varsUserSized = false;

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
    const sel = '#f5ext-launcher-wrap, #f5ext-launcher, #f5ext-panel, #f5ext-vars, .f5ext-tooltip';
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
      + '<button type="button" class="f5ext-dock-btn js-open-vars" '
      +   'title="Шаблонизатор переменных" aria-label="Шаблонизатор переменных">{…}</button>';

    const btn = document.createElement('div');
    btn.id = 'f5ext-launcher';
    btn.className = 'f5ext-launcher';
    btn.textContent = 'F5';
    btn.title = 'Открыть расшифровщик · наведите для шаблонизатора';

    launcherWrap.appendChild(launcherDock);
    launcherWrap.appendChild(btn);

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
    try { if (elements.tip && elements.tip.parentNode) elements.tip.parentNode.removeChild(elements.tip); } catch (e) {}
    elements = createEmptyElements();
    panelMounted = false;
    varsUserSized = false;
    removeOrphanDom();
  }

  function applyPanelEnabled() {
    if (state.panelEnabled && !panelMounted) mountPanel();
    else if (!state.panelEnabled && panelMounted) unmountPanel();
    else if (!state.panelEnabled) removeOrphanDom();
  }

  // Скрытие/возврат кнопки «Открыть чат с Аммой» через CSS-инъекцию.
  // Используются стабильные атрибуты (aria-label/alt/имя файла иконки), а не
  // хешированные классы amoCRM. Применяется без MutationObserver — стилевое
  // правило само распространяется на любые экземпляры кнопки на странице.
  // Чтобы вернуть Амму после её скрытия — нужна перезагрузка вкладки только
  // в случае, когда amoCRM держит её в memo-компоненте; обычно достаточно
  // снять стиль (если у кнопки нет своих transition). На практике перезагрузка
  // не требуется, но рекомендована — это стандартный путь для расширений-стилеров.
  const AMMA_STYLE_ID = 'f5ext-amma-hide';
  const AMMA_HIDE_CSS = ''
    + 'button[aria-label*="Аммой" i],'
    + 'button[aria-label*="Amma" i],'
    + 'a[aria-label*="Аммой" i],'
    + 'a[aria-label*="Amma" i] {'
    +   'display: none !important;'
    + '}';

  function applyAmmaHidden() {
    const existing = document.getElementById(AMMA_STYLE_ID);
    if (state.hideAmma) {
      if (existing) return;
      const style = document.createElement('style');
      style.id = AMMA_STYLE_ID;
      style.textContent = AMMA_HIDE_CSS;
      (document.head || document.documentElement).appendChild(style);
    } else if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
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
    if (elements.vars)  elements.vars.classList.remove('is-front');
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
  const MOD_PRESETS = [
    { value: '', label: '— без модификатора —' },
    { value: 'df(d\\.m\\.Y)', label: ':df(d\\.m\\.Y) — дата' },
    { value: 'df(d\\.m\\.Y H\\:i)', label: ':df(d\\.m\\.Y H\\:i) — дата+время' },
    { value: 'calc', label: ':calc — посчитать выражение' },
    { value: 'format(2)', label: ':format(2) — числа с разрядами' },
    { value: 'spell_price(rub, normal)', label: ':spell_price — сумма прописью' },
    { value: 'spell_num', label: ':spell_num — число прописью' },
    { value: 'noun_decl(2)', label: ':noun_decl(2) — склонение (Р.п.)' },
    { value: 'fio', label: ':fio — ФИО' },
    { value: 'fio_format(F i.o.)', label: ':fio_format(F i.o.) — Иванов И. И.' },
    { value: 'upc', label: ':upc — ВЕРХНИЙ' },
    { value: 'lwc', label: ':lwc — нижний' },
    { value: 'ucf', label: ':ucf — Первая заглавная' },
    { value: 'ucw', label: ':ucw — Каждое С Большой' },
    { value: 'length', label: ':length — длина строки' },
    { value: 'trim', label: ':trim — убрать пробелы' },
    { value: 'split(,1)', label: ':split(,1) — N-й элемент' },
    { value: 'ifempty(—)', label: ':ifempty(—) — если пусто' },
    { value: 'translit', label: ':translit — транслит' },
    { value: 'qr', label: ':qr — QR-код' }
  ];

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
    if (!sel) return;
    sel.innerHTML = '';
    for (let i = 0; i < MOD_PRESETS.length; i++) {
      const o = document.createElement('option');
      o.value = MOD_PRESETS[i].value;
      o.textContent = MOD_PRESETS[i].label;
      sel.appendChild(o);
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
    loadStateFromStorage().then(() => {
      applyPanelEnabled();
      applyAmmaHidden();
      const stale = !state.fetchedAt || (Date.now() - state.fetchedAt) > TTL_MS;
      if (stale) setTimeout(() => { refreshDictionary(); }, 1500);
    });
  }
  init();
})();
