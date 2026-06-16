/**
 * F5 Variable Resolver — обёртки над API amoCRM/Kommo.
 * Вызывается из content script — fetch идёт same-origin и cookie-сессия
 * подставляется браузером автоматически (явный access_token не нужен).
 *
 * window.F5VRApi:
 *   loadCustomFields(entityKey) — entityKey: 'leads' | 'contacts' | 'companies' | 'catalogs:<id>'
 *   loadCatalogs()
 *   loadPipelines()
 *   loadUsers()
 *   loadUserGroups()
 *   fetchAccountDictionary({ onProgress }) -> { fields, counters, errors }
 *
 * Ключи в fields:
 *   "leads:<fieldId>"             -> { name, type }
 *   "contacts:<fieldId>"          -> { name, type }
 *   "companies:<fieldId>"         -> { name, type }
 *   "catalogs:<cid>:<fieldId>"    -> { name, type, catalogId, catalogName }
 *   "pipelines:<pipelineId>"      -> { name, type: 'pipeline', sort, is_main }
 *   "statuses:<statusId>"         -> { name, type: 'status', color, sort, pipelineId, pipelineName }
 *   "users:<userId>"              -> { name, type: 'user', email, isAdmin, isActive, groupId, groupName }
 *   "usersGroups:<groupId>"       -> { name, type: 'user_group' }
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

  function fetchJson(url) {
    return fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (resp) {
        if (resp.status === 204) return null;
        if (!resp.ok) {
          var e = new Error('HTTP ' + resp.status + ' для ' + url);
          e.status = resp.status;
          throw e;
        }
        return resp.json();
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

  function normalizeFieldEnums(field) {
    var list = Array.isArray(field && field.enums) ? field.enums : [];
    var byId = {};
    var byValue = {};
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var id = e.id != null ? String(e.id) : '';
      var value = e.value != null ? String(e.value) : '';
      if (id) byId[id] = value || id;
      if (value) byValue[value] = id || value;
    }
    return { byId: byId, byValue: byValue };
  }

  function customFieldMeta(field, extra) {
    return Object.assign({
      name: field.name || ('ID ' + field.id),
      type: field.type || '',
      enums: normalizeFieldEnums(field)
    }, extra || {});
  }

  function entityPlural(entityType) {
    if (entityType === 'lead' || entityType === 'leads') return 'leads';
    if (entityType === 'contact' || entityType === 'contacts') return 'contacts';
    if (entityType === 'company' || entityType === 'companies') return 'companies';
    return '';
  }

  function loadEntity(entityType, id, withParts) {
    var plural = entityPlural(entityType);
    if (!plural || !id) return Promise.resolve(null);
    var url = '/api/v4/' + plural + '/' + encodeURIComponent(id);
    if (withParts && withParts.length) {
      url += '?with=' + encodeURIComponent(withParts.join(','));
    }
    return fetchJson(url);
  }

  function loadEntityLinks(entityType, id) {
    var plural = entityPlural(entityType);
    if (!plural || !id) return Promise.resolve([]);
    return fetchAll('/api/v4/' + plural + '/' + encodeURIComponent(id) + '/links?limit=250')
      .catch(function () { return []; });
  }

  function loadCatalogElement(catalogId, elementId) {
    if (!catalogId || !elementId) return Promise.resolve(null);
    return fetchJson('/api/v4/catalogs/' + encodeURIComponent(catalogId)
      + '/elements/' + encodeURIComponent(elementId));
  }

  function embeddedIds(entity, key) {
    var arr = entity && entity._embedded && entity._embedded[key];
    if (!Array.isArray(arr)) return [];
    return arr.map(function (it) {
      return {
        id: it && it.id != null ? String(it.id) : '',
        isMain: !!(it && (it.is_main || it.is_main_contact))
      };
    }).filter(function (it) { return !!it.id; });
  }

  function idsFromLinks(links, type) {
    return (links || []).filter(function (it) {
      return it && (it.to_entity_type === type || it.entity_type === type);
    }).map(function (it) {
      return String(it.to_entity_id || it.entity_id || '');
    }).filter(Boolean);
  }

  function pickMainId(items) {
    if (!items || !items.length) return '';
    for (var i = 0; i < items.length; i++) {
      if (items[i].isMain) return items[i].id;
    }
    return items[0].id;
  }

  function pickLatestLead(leads) {
    var best = null;
    for (var i = 0; i < leads.length; i++) {
      var lead = leads[i];
      if (!lead) continue;
      if (!best || (lead.created_at || 0) > (best.created_at || 0)) best = lead;
    }
    return best;
  }

  async function loadLinkedLeads(entityType, id, baseEntity) {
    var ids = embeddedIds(baseEntity, 'leads').map(function (it) { return it.id; });
    if (!ids.length) {
      var links = await loadEntityLinks(entityType, id);
      ids = idsFromLinks(links, 'leads');
    }
    var leads = [];
    for (var i = 0; i < ids.length; i++) {
      try {
        var lead = await loadEntity('lead', ids[i], ['contacts', 'companies']);
        if (lead) leads.push(lead);
      } catch (e) {}
    }
    return leads;
  }

  async function fetchEntityFormulaContext(entityType, id) {
    var plural = entityPlural(entityType);
    if (!plural || !id) throw new Error('Неизвестная сущность');

    var current = await loadEntity(entityType, id, ['contacts', 'companies', 'leads']);
    var ctx = {
      current: { type: plural, id: String(id) },
      lead: null,
      contact: null,
      company: null
    };

    if (plural === 'leads') {
      ctx.lead = current;
      var contactId = pickMainId(embeddedIds(current, 'contacts'));
      var companyId = pickMainId(embeddedIds(current, 'companies'));
      if (contactId) ctx.contact = await loadEntity('contact', contactId, ['companies']).catch(function () { return null; });
      if (companyId) ctx.company = await loadEntity('company', companyId, []).catch(function () { return null; });
    } else if (plural === 'contacts') {
      ctx.contact = current;
      var companyId2 = pickMainId(embeddedIds(current, 'companies'));
      if (companyId2) ctx.company = await loadEntity('company', companyId2, []).catch(function () { return null; });
      var contactLeads = await loadLinkedLeads('contact', id, current);
      ctx.lead = pickLatestLead(contactLeads);
      if (!ctx.company && ctx.lead) {
        var leadCompanyId = pickMainId(embeddedIds(ctx.lead, 'companies'));
        if (leadCompanyId) ctx.company = await loadEntity('company', leadCompanyId, []).catch(function () { return null; });
      }
    } else if (plural === 'companies') {
      ctx.company = current;
      var companyLeads = await loadLinkedLeads('company', id, current);
      ctx.lead = pickLatestLead(companyLeads);
      var companyContactId = pickMainId(embeddedIds(current, 'contacts'));
      if (!companyContactId && ctx.lead) companyContactId = pickMainId(embeddedIds(ctx.lead, 'contacts'));
      if (companyContactId) ctx.contact = await loadEntity('contact', companyContactId, ['companies']).catch(function () { return null; });
    }

    return ctx;
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

  // /api/v4/users отдаёт список только администраторам аккаунта; для обычных
  // токенов amoCRM возвращает 401/403 — в этом случае молча отдаём пустой
  // массив, чтобы остальной справочник всё равно загрузился.
  function loadUsers() {
    return fetchAll('/api/v4/users?limit=250').catch(function (e) {
      if (e && (e.status === 401 || e.status === 403)) return [];
      throw e;
    });
  }

  // /api/v4/account?with=users_groups доступен любому авторизованному
  // пользователю и возвращает все группы (отделы) аккаунта.
  function loadUserGroups() {
    return fetch('/api/v4/account?with=users_groups', { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (resp) {
        if (!resp.ok) {
          var e = new Error('HTTP ' + resp.status + ' для /api/v4/account?with=users_groups');
          e.status = resp.status;
          throw e;
        }
        return resp.json();
      })
      .then(function (data) {
        return (data && data._embedded && data._embedded.users_groups) || [];
      });
  }

  async function fetchAccountDictionary(opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};

    var fields = {};
    var counters = { leads: 0, contacts: 0, companies: 0, catalogs: 0, pipelines: 0, statuses: 0, users: 0, userGroups: 0 };
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
          fields[ent + ':' + f.id] = customFieldMeta(f);
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
          fields['catalogs:' + cid + ':' + ff.id] = customFieldMeta(ff, {
            catalogId: cid,
            catalogName: cname
          });
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

    // Группы тянем первыми, чтобы при обработке пользователей знать имена групп.
    onProgress('Группы пользователей…');
    try {
      var groups = await loadUserGroups();
      for (var gi = 0; gi < groups.length; gi++) {
        var grp = groups[gi];
        if (!grp || grp.id == null) continue;
        fields['usersGroups:' + grp.id] = {
          name: grp.name || ('Группа ' + grp.id),
          type: 'user_group'
        };
        counters.userGroups++;
      }
    } catch (e) {
      errors.push({ scope: 'usersGroups', status: e && e.status, message: e && e.message ? e.message : String(e) });
    }

    onProgress('Пользователи…');
    try {
      var users = await loadUsers();
      for (var ui = 0; ui < users.length; ui++) {
        var u = users[ui];
        if (!u || u.id == null) continue;
        var groupId = u.rights && u.rights.group_id != null ? u.rights.group_id : null;
        var groupName = '';
        if (groupId != null) {
          var gKey = 'usersGroups:' + groupId;
          if (fields[gKey]) groupName = fields[gKey].name;
        }
        fields['users:' + u.id] = {
          name: u.name || u.email || ('Пользователь ' + u.id),
          type: 'user',
          email: u.email || '',
          isAdmin: !!(u.rights && u.rights.is_admin),
          isActive: !u.rights || u.rights.is_active !== false,
          groupId: groupId != null ? String(groupId) : '',
          groupName: groupName
        };
        counters.users++;
      }
    } catch (e) {
      errors.push({ scope: 'users', status: e && e.status, message: e && e.message ? e.message : String(e) });
    }

    return { fields: fields, counters: counters, errors: errors };
  }

  global.F5VRApi = {
    loadCustomFields: loadCustomFields,
    loadEntity: loadEntity,
    loadEntityLinks: loadEntityLinks,
    loadCatalogElement: loadCatalogElement,
    fetchEntityFormulaContext: fetchEntityFormulaContext,
    loadCatalogs: loadCatalogs,
    loadPipelines: loadPipelines,
    loadUsers: loadUsers,
    loadUserGroups: loadUserGroups,
    fetchAccountDictionary: fetchAccountDictionary
  };
})(typeof window !== 'undefined' ? window : self);
