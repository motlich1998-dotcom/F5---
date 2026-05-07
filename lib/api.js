/**
 * F5 Variable Resolver — обёртки над API amoCRM/Kommo.
 * Вызывается из content script — fetch идёт same-origin и cookie-сессия
 * подставляется браузером автоматически (явный access_token не нужен).
 *
 * window.F5VRApi:
 *   loadCustomFields(entityKey) — entityKey: 'leads' | 'contacts' | 'companies' | 'catalogs:<id>'
 *   loadCatalogs()
 *   loadPipelines()
 *   fetchAccountDictionary({ onProgress }) -> { fields, counters, errors }
 *
 * Ключи в fields:
 *   "leads:<fieldId>"             -> { name, type }
 *   "contacts:<fieldId>"          -> { name, type }
 *   "companies:<fieldId>"         -> { name, type }
 *   "catalogs:<cid>:<fieldId>"    -> { name, type, catalogId, catalogName }
 *   "pipelines:<pipelineId>"      -> { name, type: 'pipeline', sort, is_main }
 *   "statuses:<statusId>"         -> { name, type: 'status', color, sort, pipelineId, pipelineName }
 */
(function (global) {
  'use strict';

  function fetchAll(url) {
    return new Promise(function (resolve, reject) {
      var items = [];
      function loadPage(u) {
        fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } })
          .then(function (resp) {
            if (resp.status === 204) return null;
            if (!resp.ok) {
              var e = new Error('HTTP ' + resp.status + ' для ' + u);
              e.status = resp.status;
              throw e;
            }
            return resp.json();
          })
          .then(function (data) {
            if (!data) { resolve(items); return; }
            var emb = data && data._embedded ? data._embedded : {};
            var keys = Object.keys(emb);
            for (var ki = 0; ki < keys.length; ki++) {
              var arr = emb[keys[ki]];
              if (Array.isArray(arr)) {
                for (var ii = 0; ii < arr.length; ii++) items.push(arr[ii]);
              }
            }
            var next = data && data._links && data._links.next && data._links.next.href;
            if (next) loadPage(next);
            else resolve(items);
          })
          .catch(reject);
      }
      loadPage(url);
    });
  }

  function loadCustomFields(entityKey) {
    var url;
    if (entityKey === 'leads' || entityKey === 'contacts' || entityKey === 'companies') {
      url = '/api/v4/' + entityKey + '/custom_fields?limit=250';
    } else if (typeof entityKey === 'string' && entityKey.indexOf('catalogs:') === 0) {
      var id = entityKey.split(':')[1];
      url = '/api/v4/catalogs/' + encodeURIComponent(id) + '/custom_fields?limit=250';
    } else {
      return Promise.reject(new Error('Unknown entity: ' + entityKey));
    }
    return fetchAll(url);
  }

  function loadCatalogs() {
    return fetchAll('/api/v4/catalogs?limit=250');
  }

  function loadPipelines() {
    // /api/v4/leads/pipelines возвращает воронки и встроенные в них этапы.
    return fetch('/api/v4/leads/pipelines', { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (resp) {
        if (!resp.ok) {
          var e = new Error('HTTP ' + resp.status + ' для /api/v4/leads/pipelines');
          e.status = resp.status;
          throw e;
        }
        return resp.json();
      })
      .then(function (data) {
        return (data && data._embedded && data._embedded.pipelines) || [];
      });
  }

  async function fetchAccountDictionary(opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};

    var fields = {};
    var counters = { leads: 0, contacts: 0, companies: 0, catalogs: 0, pipelines: 0, statuses: 0 };
    var errors = [];

    var ents = ['leads', 'contacts', 'companies'];
    for (var i = 0; i < ents.length; i++) {
      var ent = ents[i];
      onProgress('Поля сущности «' + ent + '»…');
      try {
        var list = await loadCustomFields(ent);
        for (var j = 0; j < list.length; j++) {
          var f = list[j];
          if (!f || f.id == null) continue;
          fields[ent + ':' + f.id] = {
            name: f.name || ('ID ' + f.id),
            type: f.type || ''
          };
          counters[ent]++;
        }
      } catch (e) {
        errors.push({ scope: ent, status: e && e.status, message: e && e.message ? e.message : String(e) });
      }
    }

    onProgress('Каталоги…');
    var catalogs = [];
    try {
      catalogs = await loadCatalogs();
    } catch (e) {
      errors.push({ scope: 'catalogs', status: e && e.status, message: e && e.message ? e.message : String(e) });
    }

    for (var ci = 0; ci < catalogs.length; ci++) {
      var cat = catalogs[ci];
      if (!cat || cat.id == null) continue;
      var cid = cat.id;
      var cname = cat.name || String(cid);
      onProgress('Каталог: ' + cname);
      try {
        var clist = await loadCustomFields('catalogs:' + cid);
        for (var k = 0; k < clist.length; k++) {
          var ff = clist[k];
          if (!ff || ff.id == null) continue;
          fields['catalogs:' + cid + ':' + ff.id] = {
            name: ff.name || ('ID ' + ff.id),
            type: ff.type || '',
            catalogId: cid,
            catalogName: cname
          };
          counters.catalogs++;
        }
      } catch (e) {
        errors.push({ scope: 'catalogs:' + cid, status: e && e.status, message: e && e.message ? e.message : String(e) });
      }
    }

    onProgress('Воронки и этапы…');
    try {
      var pipelines = await loadPipelines();
      for (var pi = 0; pi < pipelines.length; pi++) {
        var p = pipelines[pi];
        if (!p || p.id == null) continue;
        var pid = p.id;
        var pname = p.name || ('Воронка ' + pid);
        fields['pipelines:' + pid] = {
          name: pname,
          type: 'pipeline',
          sort: p.sort || 0,
          is_main: !!p.is_main
        };
        counters.pipelines++;
        var sts = (p._embedded && p._embedded.statuses) || [];
        for (var si = 0; si < sts.length; si++) {
          var st = sts[si];
          if (!st || st.id == null) continue;
          fields['statuses:' + st.id] = {
            name: st.name || ('Этап ' + st.id),
            type: 'status',
            color: st.color || '',
            sort: st.sort || 0,
            pipelineId: pid,
            pipelineName: pname
          };
          counters.statuses++;
        }
      }
    } catch (e) {
      errors.push({ scope: 'pipelines', status: e && e.status, message: e && e.message ? e.message : String(e) });
    }

    return { fields: fields, counters: counters, errors: errors };
  }

  global.F5VRApi = {
    loadCustomFields: loadCustomFields,
    loadCatalogs: loadCatalogs,
    loadPipelines: loadPipelines,
    fetchAccountDictionary: fetchAccountDictionary
  };
})(typeof window !== 'undefined' ? window : self);
