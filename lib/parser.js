/**
 * F5 Variable Resolver — парсер переменных и справочник модификаторов.
 * Логика выровнена с виджетом «Расшифровка переменных».
 *
 * Экспонирует window.F5VRParser:
 *  - extractFieldRefs(text, opts?)                 — найти все ссылки. Каждая ref имеет kind: 'cf' | 'system' | 'idhint'.
 *                                                     opts.idIndex — словарь известных id { '<id>': true } для подсветки «голых» ID.
 *  - normalizeEntityToken(token)
 *  - entityLabel(entityKey)
 *  - fieldTypeLabel(field|type)
 *  - getModifierHelp(name)
 *  - getSystemVarHelp(rootEntity, path) — описание базовых переменных (lead.name, date.now, ...)
 *  - escapeHtml(value)
 *  - renderMirrorHtml(text, refs, resolveLabel, opts?) — HTML для подсветки. opts.idIndex как у extractFieldRefs.
 *
 *  resolveLabel(ref) -> { label: string, type?: string } | null   (только для kind === 'cf')
 */
(function (global) {
  'use strict';

  function normalizeEntityToken(token) {
    var t = (token || '').toString().trim().toLowerCase();
    if (t === 'lead' || t === 'leads') return 'leads';
    if (t === 'contact' || t === 'contacts') return 'contacts';
    if (t === 'company' || t === 'companies') return 'companies';
    return null;
  }

  function entityLabel(entityKey) {
    if (entityKey === 'leads') return 'Сделка';
    if (entityKey === 'contacts') return 'Контакт';
    if (entityKey === 'companies') return 'Компания';
    if (entityKey === 'pipelines') return 'Воронка';
    if (entityKey === 'statuses') return 'Этап воронки';
    if (entityKey === 'users') return 'Пользователь';
    if (entityKey === 'usersGroups') return 'Группа пользователей';
    if (typeof entityKey === 'string' && entityKey.indexOf('catalogs:') === 0) {
      var cid = entityKey.split(':')[1] || '';
      return 'Каталог' + (cid ? ' ' + cid : '');
    }
    return entityKey || '';
  }

  function fieldTypeLabel(fieldOrType) {
    var t = '';
    if (fieldOrType && typeof fieldOrType === 'object') {
      t = fieldOrType.type != null ? String(fieldOrType.type) : '';
    } else if (fieldOrType != null) {
      t = String(fieldOrType);
    }
    t = t.toLowerCase();
    if (!t) return '';
    var map = {
      'text': 'Текст',
      'textarea': 'Текст',
      'numeric': 'Число',
      'number': 'Число',
      'date': 'Дата',
      'date_time': 'Дата/время',
      'datetime': 'Дата/время',
      'select': 'Список',
      'multiselect': 'Мульти-список',
      'checkbox': 'Флажок',
      'radiobutton': 'Список',
      'url': 'Ссылка',
      'phone': 'Телефон',
      'email': 'Email',
      'file': 'Файл',
      'files': 'Файл',
      'streetaddress': 'Адрес',
      'address': 'Адрес',
      'price': 'Цена',
      'birthday': 'Дата (день рождения)',
      'legal_entity': 'Юр.лицо',
      'tracking_data': 'Источник трафика',
      'monetary': 'Денежное',
      'category': 'Категория',
      'items': 'Товары',
      'linked_entity': 'Связанная сущность',
      'pipeline': 'Воронка',
      'status': 'Этап воронки'
    };
    return map[t] || t;
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return value.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function extractFieldRefs(rawText, opts) {
    opts = opts || {};
    var text = (rawText || '').toString();
    var matches = [];
    var ranges = [];

    function inRange(idx) {
      for (var r = 0; r < ranges.length; r++) {
        if (idx >= ranges[r][0] && idx < ranges[r][1]) return true;
      }
      return false;
    }
    function pushRange(start, end) { ranges.push([start, end]); }

    // cf/cfm/cff/sf/cfyur/previousCf — все принимают id как первый аргумент;
    // sf и cfyur могут иметь дополнительные аргументы (sf(id, N), cfyur(id, name)).
    var reEntity = /(\{\{\s*)?([a-zA-Z]+)\s*(\([^)]*\))?\s*\.\s*(cf|cfm|cff|sf|cfyur|previousCf)\s*\(\s*(\d+)\s*(?:,[^)]*)?\)(\s*\}\})?/g;
    var m;
    while ((m = reEntity.exec(text)) !== null) {
      var ent = normalizeEntityToken(m[2]);
      if (!ent) continue;
      matches.push({
        kind: 'cf',
        original: m[0],
        entityKey: ent,
        accessor: m[4],
        fieldId: String(m[5]),
        index: m.index
      });
      pushRange(m.index, m.index + m[0].length);
    }

    var reCatalog = /(\{\{\s*)?catalogElement\s*\(\s*[^,]*,\s*(\d+)\s*\)\s*\.\s*cf\s*\(\s*(\d+)\s*\)(\s*\}\})?/g;
    while ((m = reCatalog.exec(text)) !== null) {
      matches.push({
        kind: 'cf',
        original: m[0],
        entityKey: 'catalogs:' + String(m[2]),
        accessor: 'cf',
        fieldId: String(m[3]),
        index: m.index
      });
      pushRange(m.index, m.index + m[0].length);
    }

    var reSystem = /(\{\{\s*)?\b(lead|contact|company|client|date|random|users|user)\b(\s*\(([^)]*)\))?\s*\.\s*([a-zA-Z_]\w*(?:\s*\.\s*[a-zA-Z_]\w*)*)(\s*\(([^)]*)\))?(\s*\}\})?/g;
    while ((m = reSystem.exec(text)) !== null) {
      if (inRange(m.index)) continue;
      var rootEntity = m[2].toLowerCase();
      var rootArgs = m[4] || '';
      var path = (m[5] || '').replace(/\s+/g, '');
      var fnArgs = m[7] || '';
      // Skip cf-style references already handled выше (например, lead.cf(123)).
      if (/^(cf|cfm|cff|sf|cfyur|previouscf)$/i.test(path) && /^\d+(\s*,.*)?$/.test(fnArgs.trim())) continue;
      matches.push({
        kind: 'system',
        original: m[0],
        rootEntity: rootEntity,
        rootArgs: rootArgs,
        path: path,
        fnArgs: fnArgs,
        index: m.index
      });
      pushRange(m.index, m.index + m[0].length);
    }

    // Подсветка «голых» ID: если в свободном тексте встречается число,
    // которое равно известному id из словаря — отметим его как 'idhint'.
    if (opts.idIndex) {
      var reNumber = /\b\d{3,}\b/g;
      while ((m = reNumber.exec(text)) !== null) {
        if (inRange(m.index)) continue;
        var idStr = m[0];
        if (!opts.idIndex[idStr]) continue;
        matches.push({
          kind: 'idhint',
          original: idStr,
          fieldId: idStr,
          index: m.index
        });
        pushRange(m.index, m.index + idStr.length);
      }
    }

    matches.sort(function (a, b) { return a.index - b.index; });
    return matches;
  }

  // Базовые/системные переменные шаблонизатора amoCRM (cmdf5.ru/manual/vars).
  // Ключ — канонический путь. '<entity>' заменяется на lead/contact/company/client при поиске.
  var SYS_HELP = {
    '<entity>.name':                 { desc: 'Название/имя сущности.', example: 'Заявка с сайта · Иван Петров · ООО «Команда Ф5»' },
    '<entity>.id':                   { desc: 'Уникальный ID сущности.', example: '4563218' },
    '<entity>.tag':                  { desc: 'Один тег сущности.', example: '«заявка с сайта»' },
    '<entity>.tags':                 { desc: 'Все теги сущности через запятую.', example: '«заявка с сайта», «директ»' },
    '<entity>.tagsCount':            { desc: 'Количество тегов сущности.', example: '3' },
    '<entity>.created_at':           { desc: 'Дата создания (UNIX/ISO). Применяйте :df(...) для форматирования.', example: '{{lead.created_at:df(d.m.Y H:i)}} → 21.11.2019 16:03' },
    '<entity>.updated_at':           { desc: 'Дата последнего изменения. Применяйте :df(...).', example: '{{lead.updated_at:df(d.m.Y)}}' },
    '<entity>.closed_at':            { desc: 'Дата закрытия (для сделок). Применяйте :df(...).' },
    '<entity>.created_by':           { desc: 'ID пользователя, создавшего сущность (0 = робот).', example: '2340560' },
    '<entity>.responsible.id':       { desc: 'ID ответственного.', example: '123654' },
    '<entity>.responsible.name':     { desc: 'Имя ответственного.', example: 'Максим Петров' },
    '<entity>.responsible.email':    { desc: 'E-mail ответственного.', example: 'manager@mail.ru' },
    '<entity>.responsible.login':    { desc: 'Логин (e-mail для входа) ответственного.', example: 'manager@gmail.com' },
    '<entity>.responsible.group_id': { desc: 'ID группы (отдела) ответственного.' },
    '<entity>.responsible.group_name': { desc: 'Название группы (отдела) ответственного.', example: 'Отдел продаж' },
    '<entity>.previousResponsibleId':{ desc: 'ID предыдущего ответственного.' },
    '<entity>.previousResponsible.group_id':   { desc: 'ID группы предыдущего ответственного.' },
    '<entity>.previousResponsible.group_name': { desc: 'Название группы предыдущего ответственного.' },

    'lead.name':                     { desc: 'Название сделки.', example: '«Заявка с сайта»' },
    'lead.id':                       { desc: 'ID сделки.', example: '456321' },
    'contact.name':                  { desc: 'Полное имя контакта.', example: 'Евгений Миронов' },
    'contact.id':                    { desc: 'ID контакта.', example: '45645673' },
    'company.name':                  { desc: 'Название компании.', example: 'ООО «Креатив»' },
    'company.id':                    { desc: 'ID компании.', example: '4353534' },

    'lead.sale':                     { desc: 'Бюджет сделки.', example: '58000' },
    'lead.previousSale':             { desc: 'Предыдущий бюджет (если был изменён, иначе пусто).', example: '45000' },
    'lead.company_id':               { desc: 'ID компании, прикреплённой к сделке.' },
    'lead.contactsCount':            { desc: 'Количество контактов в сделке.' },
    'lead.loss_reason_id':           { desc: 'ID причины отказа.' },
    'lead.loss_reason_name':         { desc: 'Название причины отказа.', example: 'Выбрали других' },
    'lead.pipeline':                 { desc: 'Имя воронки.', example: 'Продажи' },
    'lead.status':                   { desc: 'Имя текущего этапа (статуса) сделки.', example: 'Счёт отправлен' },
    'lead.status_id':                { desc: 'ID текущего этапа сделки.' },
    'lead.status.id':                { desc: 'ID текущего этапа сделки (точечная нотация).' },
    'lead.status.name':              { desc: 'Имя текущего этапа сделки.' },
    'lead.status.next.id':           { desc: 'ID следующего этапа воронки.' },
    'lead.status.next.name':         { desc: 'Имя следующего этапа воронки.' },
    'lead.status.previous.id':       { desc: 'ID предыдущего этапа воронки.' },
    'lead.status.previous.name':     { desc: 'Имя предыдущего этапа воронки.' },
    'lead.previousStatus':           { desc: 'Имя предыдущего этапа сделки.' },
    'lead.previousStatusId':         { desc: 'ID предыдущего этапа сделки.' },
    'lead.previousPipeline':         { desc: 'Имя предыдущей воронки.' },
    'lead.previousPipelineId':       { desc: 'ID предыдущей воронки.' },
    'lead.source_id':                { desc: 'ID источника сделки (раздел Статистика).' },
    'lead.source_name':              { desc: 'Название источника сделки.' },
    'lead.catalogElementNames':      { desc: 'Заголовки всех товаров сделки через запятую.', example: 'Футболка, Майка, Носки' },
    'lead.tasksCount':               { desc: 'Количество всех задач сделки. Доп. фильтры: open, closed, expired, тип, «тип/статус».', example: '{{lead.tasksCount(open)}} → 3' },
    'lead.tasksIds':                 { desc: 'Список ID задач сделки. Поддерживает фильтры open/closed/expired/тип.' },
    'lead.closest_task_at':          { desc: 'Дата ближайшей задачи (UNIX). Используйте арифметику и :df.' },
    'lead.dialogMessages':           { desc: 'Полный текст переписки (до 50 сообщений). Доп. (all|client|manager, N).' },
    'lead.dialogLastMessageCreatedAt': { desc: 'Timestamp последнего сообщения в диалоге.' },
    'lead.dialogLastMessageSender':  { desc: 'Кто отправил последнее сообщение: client или manager.' },

    'contact.first_name':            { desc: 'Имя контакта (если поле заполнено).', example: 'Евгений' },
    'contact.last_name':             { desc: 'Фамилия контакта (отдельное поле).', example: 'Миронов' },
    'contact.email':                 { desc: 'Основной e-mail контакта.', example: 'contact@mail.ru' },
    'contact.emails':                { desc: 'Все e-mail контакта через запятую. Используйте :split(,N) для конкретного.' },
    'contact.phone':                 { desc: 'Основной телефон контакта.' },
    'contact.phones':                { desc: 'Все телефоны контакта через запятую. Используйте :split(,N) для конкретного.' },
    'contact.company_name':          { desc: 'Название компании контакта.' },
    'contact.company_id':            { desc: 'ID компании контакта.' },
    'contact.dialogMessages':        { desc: 'Полная переписка по контакту.' },
    'contact.dialogLastMessageCreatedAt': { desc: 'Timestamp последнего сообщения по контакту.' },
    'contact.dialogLastMessageSender':    { desc: 'Кто отправил последнее сообщение по контакту.' },

    'client.name':                   { desc: 'Имя текущего/основного контакта (если нет — компании).' },
    'client.id':                     { desc: 'ID текущего/основного контакта (если нет — компании).' },
    'client.responsible.name':       { desc: 'Имя ответственного клиента.' },
    'client.phone':                  { desc: 'Телефон клиента (контакта или компании).' },

    // Подсчёты сделок — доступны только на контакте/компании.
    'contact.leadsCount':            { desc: 'Кол-во сделок контакта. Фильтры: open|success|loss|closed, «142,143» (status_id), «id_воронки/id_статуса».', example: '{{contact.leadsCount(open)}} → 5' },
    'contact.leadsSum':              { desc: 'Сумма бюджетов сделок контакта. Те же фильтры, что у leadsCount.' },
    'contact.leadsIds':              { desc: 'ID сделок контакта через запятую. Те же фильтры.' },
    'company.leadsCount':            { desc: 'Кол-во сделок компании. Те же фильтры.' },
    'company.leadsSum':              { desc: 'Сумма бюджетов сделок компании. Те же фильтры.' },
    'company.leadsIds':              { desc: 'ID сделок компании через запятую. Те же фильтры.' },

    'date.now':                      { desc: 'Текущая дата и время (ISO). С :df управляет форматом.', example: '{{date.now:df(d.m.Y H:i)}} → 26.03.2021 18:46' },
    'date.tomorrow':                 { desc: 'Завтра (00:00:00).', example: '2020-02-04 00:00:00' },
    'date.yesterday':                { desc: 'Вчера (00:00:00).' },
    'date.nextweek':                 { desc: 'Следующий понедельник в это же время.' },
    'date.nextmonth':                { desc: 'Через месяц в этот же день и время.' },

    'users.name':                    { desc: 'Имя пользователя amoCRM по ID.', example: '{{users(1234567).name}} → Иванов Иван', insert: '{{users(<id>).name}}' },
    'users.id':                      { desc: 'ID пользователя по e-mail. Аргумент — entry({{...}}).', insert: '{{users({{entry(<email>):quotemeta}}).id}}' },
    'users.group_id':                { desc: 'ID группы (отдела) пользователя.', insert: '{{users(<id>).group_id}}' },
    'users.group_name':              { desc: 'Название группы (отдела) пользователя.', insert: '{{users(<id>).group_name}}' },
    'users.login':                   { desc: 'Почтовый ящик (login) пользователя.', insert: '{{users(<id>).login}}' },
    'users.phone':                   { desc: 'Телефон пользователя.', insert: '{{users(<id>).phone}}' },
    'users.is_admin':                { desc: 'Признак администратора (1/0).', insert: '{{users(<id>).is_admin}}' },
    'users.language':                { desc: 'Язык интерфейса пользователя.', example: 'ru', insert: '{{users(<id>).language}}' },

    'random.str':                    { desc: 'Случайная строка. random.str(N) — длина, random.str(N, alpha) — только буквы.', example: '{{random.str(10)}}', insert: '{{random.str(10)}}' },
    'random.num':                    { desc: 'Случайное целое. random.num(min, max) — диапазон.', example: '{{random.num(1000, 9999)}}', insert: '{{random.num(1, 100)}}' },
    'random.float':                  { desc: 'Случайное число с плавающей точкой. random.float(N) — до N.', insert: '{{random.float}}' },

    'date.next':                     { desc: 'Следующий день недели или интервал. Аргументы: day, Wednesday, ...', example: '{{date.next(Wednesday)}}', insert: '{{date.next(day)}}' },
    'date.custom':                   { desc: 'Произвольная дата относительно сейчас. Принимает строки strtotime.', example: '{{date.custom(7 days)}}, {{date.custom(last monday of this month)}}', insert: '{{date.custom(7 days)}}' }
  };

  function listSystemVars() {
    // Прямые ключи имеют приоритет над шаблоном <entity>.*, чтобы не было дубликатов
    // (например 'lead.id' переопределяет '<entity>.id' для сущности lead).
    var ENTITIES = ['lead', 'contact', 'company', 'client'];
    var byCanonical = {};
    function add(canonical, root, pth, info) {
      byCanonical[canonical] = {
        kind: 'system',
        rootEntity: root,
        path: pth,
        canonical: canonical,
        desc: info.desc || '',
        example: info.example || '',
        insert: info.insert || ('{{' + canonical + '}}')
      };
    }
    // 1) шаблон <entity>.*
    for (var key in SYS_HELP) {
      if (!Object.prototype.hasOwnProperty.call(SYS_HELP, key)) continue;
      if (key.indexOf('<entity>.') !== 0) continue;
      var sub = key.substring('<entity>.'.length);
      for (var i = 0; i < ENTITIES.length; i++) {
        var e = ENTITIES[i];
        add(e + '.' + sub, e, sub, SYS_HELP[key]);
      }
    }
    // 2) прямые ключи перекрывают шаблонные.
    for (var k2 in SYS_HELP) {
      if (!Object.prototype.hasOwnProperty.call(SYS_HELP, k2)) continue;
      if (k2.indexOf('<entity>.') === 0) continue;
      var dot = k2.indexOf('.');
      var root = dot >= 0 ? k2.substring(0, dot) : k2;
      var pth = dot >= 0 ? k2.substring(dot + 1) : '';
      add(k2, root, pth, SYS_HELP[k2]);
    }
    var out = [];
    for (var c in byCanonical) {
      if (Object.prototype.hasOwnProperty.call(byCanonical, c)) out.push(byCanonical[c]);
    }
    return out;
  }

  function getSystemVarHelp(rootEntity, path) {
    if (!rootEntity || !path) return null;
    var direct = SYS_HELP[rootEntity + '.' + path];
    if (direct) return direct;
    if (rootEntity === 'lead' || rootEntity === 'contact' || rootEntity === 'company' || rootEntity === 'client') {
      var shared = SYS_HELP['<entity>.' + path];
      if (shared) return shared;
    }
    return null;
  }

  function getModifierHelp(name) {
    var n = (name || '').toString().toLowerCase();
    var map = {
      // ===== Математика и числа =====
      calc: {
        desc: 'Калькуляция выражения: + − × ÷ и скобки.',
        examples: [
          '{{({{lead.cf(100)}}+500):calc}} → сумма поля и 500',
          '{{({{lead.sale}}/{{lead.cf(200)}}):calc}} → деление полей'
        ]
      },
      format: {
        desc: 'Оформление числа: округление и разделители разрядов/десятичной части. format(decimals, decimal_separator, thousands_separator).',
        examples: [
          '{{lead.sale:format(0)}} → 4 500 000',
          '{{lead.cf(609649):format(2)}} → 12.15',
          '{{lead.sale:format(2,\\,,_)}} → 1_000_000,00'
        ]
      },
      'float': {
        desc: 'Преобразовать число в дробь с указанным числом знаков.',
        examples: ['{{lead.sale:float(1)}} → 58000.0']
      },
      round: {
        desc: 'Округление до указанного разряда (0 — до целого).',
        examples: ['{{lead.cf(123):round(2)}}: 15.756 → 15.76']
      },
      floor: {
        desc: 'Округление вниз (в меньшую сторону).',
        examples: ['{{lead.cf(123):floor}}: 15.75 → 15']
      },
      ceil: {
        desc: 'Округление вверх (в большую сторону).',
        examples: ['{{lead.cf(123):ceil}}: 15.25 → 16']
      },
      currencyconvert: {
        desc: 'Конвертация в другую валюту по курсу ЦБ. Поддержка: USD, EUR, BYN, UAH, CNY, TRY, GBP.',
        examples: ['{{lead.sale:currencyConvert(USD)}}: 5000 → 68.06']
      },
      iseven: {
        desc: 'Проверка на чётность: 1 — чётное, 0 — нечётное.',
        examples: ['{{lead.sale:isEven:if(=,1,чёт,нечёт)}}']
      },

      // ===== Прописью =====
      spell_money: {
        desc: 'Сумма прописью с локалью и валютой. spell_money(locale=ru, currency=rub|uah|kzt|sum|...).',
        examples: [
          '{{lead.cf(123):spell_money(locale=ru, currency=rub)}} → девять рублей ноль копеек',
          '{{lead.cf(123):spell_money(locale=uz_l, currency=sum)}} → to\'qqiz so\'m nol tiyin'
        ]
      },
      spell_price: {
        desc: 'Сумма прописью с валютой. Аргументы: (валюта, формат). Форматы: short, normal, duplication, clarification.',
        examples: [
          '{{lead.sale:spell_price}} → пятьдесят пять тысяч рублей ноль копеек',
          '{{lead.sale:spell_price(rub, short)}} → 150000 рублей 45 копеек',
          '{{lead.sale:spell_price(usd)}} → пятьдесят пять тысяч два доллара ноль центов'
        ]
      },
      spell_num: {
        desc: 'Число прописью.',
        examples: ['{{lead.cf(id):spell_num}}: 55000 → пятьдесят пять тысяч']
      },
      spell_ordinal: {
        desc: 'Порядковое числительное прописью. Может принимать падеж.',
        examples: ['{{1234:spell_num(2)}} → одной тысячи двухсот тридцати четырёх']
      },
      spell_date: {
        desc: 'Дата текстом (полностью прописью).',
        examples: ['{{lead.cf(123):spell_date}} → восемнадцатое октября две тысячи двадцать второго года']
      },

      // ===== Склонение =====
      noun_decl: {
        desc: 'Склонение слова или ФИО по падежам. Аргумент — номер падежа: 1 (И), 2 (Р), 3 (Д), 4 (В), 5 (Т), 6 (П).',
        examples: [
          '{{user.name:noun_decl(2):ucf}}: Иван → Ивана',
          '{{user.name:noun_decl(3):ucf}}: Иван → Ивану'
        ]
      },
      noun_mdecl: {
        desc: 'Склонение слова во множественное число по падежу.',
        examples: ['{{lead.cf(123):noun_mdecl(1)}}: стакан → стаканы']
      },
      noun_plur: {
        desc: 'Корректное окончание существительного по числу.',
        examples: ['{{lead.cf(123):noun_plur(грамм)}}: 45 → 45 грамм']
      },

      // ===== Регистр =====
      ucf: {
        desc: 'Первый символ первого слова — в верхний регистр.',
        examples: ['{{contact.cf(123):lwc:ucf}}: компьютер → Компьютер']
      },
      ucw: {
        desc: 'Первый символ каждого слова — в верхний регистр.',
        examples: ['{{contact.cf(123):lwc:ucw}}: российская федерация → Российская Федерация']
      },
      lwc: {
        desc: 'Текст в нижнем регистре.',
        examples: ['{{company.name:lwc}}: КОМПЬЮТЕР → компьютер']
      },
      upc: {
        desc: 'Текст в ВЕРХНЕМ регистре (КАПС).',
        examples: ['{{company.name:upc}}: компьютер → КОМПЬЮТЕР']
      },
      // Алиасы — для подстраховки на случай, если пользователь привык к ним из других систем.
      caps:       { desc: 'Алиас :upc — текст в ВЕРХНЕМ регистре.', examples: ['{{contact.name:caps}} → ИВАН ИВАНОВ'] },
      capitalize: { desc: 'Алиас :ucf — первая буква заглавной.', examples: ['{{lead.name:capitalize}} → Заявка с сайта'] },
      lower:      { desc: 'Алиас :lwc — текст в нижнем регистре.', examples: ['{{contact.email:lower}} → test@mail.ru'] },
      upper:      { desc: 'Алиас :upc — текст в ВЕРХНЕМ регистре.', examples: ['{{contact.email:upper}} → TEST@MAIL.RU'] },

      // ===== ФИО / Гео =====
      fio: {
        desc: 'ФИО получателя. Без аргумента — полное ФИО; (1) — Имя, (2) — Фамилия, (3) — Отчество.',
        examples: [
          '{{lead.cf(609615):fio}} → Иванов Иван Иванович',
          '{{lead.cf(609615):fio(1)}} → Иван',
          '{{lead.cf(609615):fio(2)}} → Иванов'
        ]
      },
      fio_format: {
        desc: 'Кастомный формат ФИО. F — Фамилия, I — Имя, O — Отчество (строчные — сокращение).',
        examples: [
          '{{lead.cf(609615):fio_format(F i\\.o\\.)}} → Иванов И. И.',
          '{{lead.cf(609615):fio_format(I O F)}} → Иван Иванович Иванов'
        ]
      },
      infl_name: {
        desc: 'Склонение ФИО по падежу для славянских имён (требует полное ФИО).',
        examples: ['{{lead.cf(123):fio:infl_name(2)}} → Иванову Ивану Ивановичу']
      },
      infl_geo: {
        desc: 'Склонение гео-данных (городов, регионов) по падежу.',
        examples: ['из {{contact.cf(123):infl_geo(2)}} → из Москвы']
      },

      // ===== Условия =====
      'if': {
        desc: 'Условие. Операторы: =, >, <, in, not in, match, not match. if(оператор, значение, тогда [, иначе]).',
        examples: [
          '{{lead.cf(123):if(>,9,20)}} — если >9, вернёт 20, иначе само значение',
          '{{contact.cf(123):if(>,9,20,0)}} — если >9 → 20, иначе → 0',
          '{{lead.cf(123):if(in,Москва||Питер,МСК+СПб,{{lead.name}})}}'
        ]
      },
      ifempty: {
        desc: 'Если значение пустое — подставить аргумент.',
        examples: [
          '{{lead.cf(123):ifempty(—)}} — если пусто, выведет «—»',
          '{{contact.first_name:ifempty({{contact.name}})}}'
        ]
      },
      ifnotempty: {
        desc: 'Если значение заполнено — подставить аргумент (иначе вернёт исходное).',
        examples: ['{{lead.cf(123):ifnotempty(заполнено)}}']
      },

      // ===== Род / служебные слова =====
      gender: {
        desc: 'Определение рода: f — женский, m — мужской.',
        examples: ['{{contact.name:gender:if(=,f,Уважаемая,Уважаемый)}}']
      },
      sp_verb: {
        desc: 'Согласует глагол по роду имени (м/ж).',
        examples: ['{{user.name}} {{user.name:sp_verb(оформил)}} → Анна оформила / Иван оформил']
      },
      sp_in: {
        desc: 'Добавляет предлог «в» или «во» в зависимости от первой буквы.',
        examples: ['{{lead.cf(123):sp_in}}: «17:00» → «в 17:00»']
      },
      sp_with: {
        desc: 'Добавляет предлог «с» или «со» в зависимости от первой буквы.',
        examples: ['{{lead.cf(123):sp_with}}: «17:00» → «с 17:00»']
      },
      sp_about: {
        desc: 'Добавляет предлог «о» / «об» / «обо» в зависимости от первых букв.',
        examples: ['{{lead.cf(123):sp_about}}: «акции» → «об акции»']
      },

      // ===== Строки =====
      length: {
        desc: 'Длина строки в символах.',
        examples: ['{{lead.cf(123):length}}: «сумма» → 5']
      },
      pad_left: {
        desc: 'Дополнить слева заданным символом до нужной длины.',
        examples: ['{{695:pad_left(6, 0)}} → 000695']
      },
      pad_right: {
        desc: 'Дополнить справа заданным символом до нужной длины.',
        examples: ['{{695:pad_right(6, 0)}} → 695000']
      },
      nbr: {
        desc: 'Сохранить переводы строк (`\\n` → `<br>`) при выводе значения.',
        examples: ['{{lead.cf(123):nbr}}']
      },
      tonumeric: {
        desc: 'Оставить только цифры, удалив все остальные символы.',
        examples: ['{{lead.cf(123):toNumeric}}: «+7 (495) 1234567 рабочий» → 74951234567']
      },
      slice: {
        desc: 'Срез строки. slice(начало, конец?) — индексы могут быть отрицательными.',
        examples: [
          '{{lead.cf(123):slice(-1)}}: «abcdef» → «f»',
          '{{lead.cf(123):slice(0, 4)}}: «abcdef» → «abcd»',
          '{{lead.cf(123):slice(2, -1)}}: «abcdef» → «cde»'
        ]
      },
      substr: {
        desc: 'Подстрока. substr(позиция, длина).',
        examples: ['{{contact.name:split(s,2):substr(1,1)}} — первая буква имени']
      },
      replace: {
        desc: 'Поиск и замена подстроки. replace(искать, заменить).',
        examples: [
          '{{lead.name:replace(Заявка,Лид)}}: «Заявка с сайта» → «Лид с сайта»',
          '{{contact.phone:replace(+7,8)}}: «+79998887766» → «89998887766»'
        ]
      },
      trim: {
        desc: 'Убрать пробелы по краям строки.',
        examples: ['{{lead.cf(123):trim}}: «  abc  » → «abc»']
      },
      split: {
        desc: 'Разделить строку по разделителю и взять элемент. split(разделитель, индекс|end). Спец. «s» — пробел.',
        examples: [
          '{{contact.phones:split(,1)}} → 2-й телефон',
          '{{contact.emails:split(,end)}} → последний email',
          '{{contact.name:split(s,1)}} — первое слово (фамилия/имя)'
        ]
      },
      translit: {
        desc: 'Транслитерация в латиницу.',
        examples: ['{{lead.cf(123,Москва):translit:lwc:ucf}} → Moskva']
      },
      part: {
        desc: 'Список с разделителем. Аргумент: br (перевод строки), rn (\\r\\n), ul (маркированный), ol (нумерованный).',
        examples: [
          '{{lead.cfm(123):part(br)}} — Товар<br>Товар 2<br>Товар 3',
          '{{lead.cfm(123):part(ul)}} — • Товар<br>• Товар 2',
          '{{lead.cfm(123):part(ol)}} — 1. Товар<br>2. Товар 2'
        ]
      },

      // ===== Дата / время =====
      df: {
        desc: 'Формат даты/времени по PHP-нотации (см. php.net/manual/ru/datetime.format.php). Можно вторым аргументом передать локаль (ru).',
        examples: [
          '{{lead.cf(123):df(d.m.Y H:i)}} → 21.11.2019 16:03',
          '{{date.now:df(d F,ru)}} → 21 ноября',
          '{{date.now:df(U)}} → 1540846800 (UNIX time)'
        ]
      },
      dm: {
        desc: 'Манипуляция датой: dm(формат, выражение). Меняет дату по правилам strtotime и форматирует.',
        examples: [
          '{{lead.cf(123):dm(d.m.Y H:i:s,next month)}}',
          '{{lead.cf(123):dm(d.m.Y,last day of next month)}}'
        ]
      },
      date_diff: {
        desc: 'Разница между датами. date_diff(вторая_дата_unix, формат). Спецификаторы: %a — все дни, %m — месяцы, %d — дни, %h — часы, %i — минуты, %s — секунды.',
        examples: [
          '{{lead.cf(123):date_diff}} → разница в днях',
          '{{lead.cf(123):date_diff({{date.now:df(U)}}, %m мес. %a дн.)}}'
        ]
      },
      addworkdays: {
        desc: 'Прибавить N рабочих дней (по производственному календарю РФ).',
        examples: [
          '{{lead.cf(123):addworkdays(10)}}: 26.12.2021 → 14.01.2022',
          '{{date.now:addworkdays(7)}}'
        ]
      },
      nextworkday: {
        desc: 'Следующий рабочий день. Аргумент — формат вывода.',
        examples: ['{{lead.cf(123):nextworkday(d F Y, ru)}}: 11 августа 2021 → 12 августа 2021']
      },
      previousworkday: {
        desc: 'Предыдущий рабочий день. Аргумент — формат вывода.',
        examples: ['{{lead.cf(123):previousworkday(d F Y, ru)}}: 6 июля 2025 (вс) → 4 июля 2025 (пт)']
      },
      isworkday: {
        desc: 'Рабочий ли день: 1 — рабочий, 0 — нет. Аргумент — код календаря (по умолчанию РФ).',
        examples: [
          '{{lead.cf(123):isworkday}}',
          '{{lead.cf(123):isworkday(by)}} — по белорусскому календарю'
        ]
      },

      // ===== Прочее =====
      timezone: {
        desc: 'Часовой пояс по номеру телефона (РФ). Возвращает смещение, например +3.',
        examples: ['{{contact.phone:timezone}} → +3']
      },
      region: {
        desc: 'Название региона РФ по номеру телефона.',
        examples: ['{{contact.phone:region}} → Чувашская Республика']
      },
      qr: {
        desc: 'QR-код. Возвращает URL PNG-картинки с закодированным значением.',
        examples: ['{{lead.cf(123):qr}} → https://...png']
      },
      ordinal_num: {
        desc: 'Число → порядковое числительное. ordinal_num(падеж, род). Род: m, f, n.',
        examples: [
          '{{lead.cf(123):ordinal_num}} → седьмой',
          '{{lead.cf(123):ordinal_num(1, f)}} → одиннадцатая',
          '{{lead.cf(123):ordinal_num(1, n)}} → сорок пятое'
        ]
      },
      quotemeta: {
        desc: 'Экранирует regex-спецсимволы. Используется в entry({...}) перед другими модификаторами.',
        examples: ['{{users({{entry(manager@mail.ru):quotemeta}}).id}}']
      },

      // ===== Виджет «Документы» =====
      insertimage: {
        desc: 'Вставка изображения по ссылке из поля. Аргумент — ширина в пунктах (pt).',
        examples: [
          '{{lead.cf(123):insertImage}}',
          '{{lead.cf(123):insertImage(100)}}'
        ]
      },
      insertlink: {
        desc: 'Вставка кликабельной ссылки. Аргумент — текст ссылки.',
        examples: [
          '{{lead.cf(123):insertLink}}',
          '{{lead.cf(123):insertLink(ссылка на договор)}}'
        ]
      },
      inserttable: {
        desc: 'Вставка таблицы по её ID, который хранится в поле amoCRM.',
        examples: [
          '{{lead.cf(123):insertTable}}',
          '{{lead.cf(123):if(=,1,111,222):insertTable}} — выбор по условию'
        ]
      },
      row: {
        desc: 'Динамические строки таблицы товаров (виджет «Документы»). Добавляется в первый столбец.',
        examples: ['{catalog.0.element.number:row}']
      }
    };
    return map[n] || null;
  }

  function renderRefInner(ref, idIndex) {
    // Outputs colored sub-tokens for the original variable text:
    // entity name -> .f5ext-tok-ent, accessor (cf/cfm/...) -> .f5ext-tok-fn,
    // numbers -> .f5ext-tok-num, parens/dots -> .f5ext-tok-op
    var inner = '';
    var s = ref.original;
    var i = 0;
    while (i < s.length) {
      var ch = s[i];
      if (ch === '{' && s[i + 1] === '{') { inner += '<span class="f5ext-brace">{{</span>'; i += 2; continue; }
      if (ch === '}' && s[i + 1] === '}') { inner += '<span class="f5ext-brace">}}</span>'; i += 2; continue; }
      if (ch === '(' || ch === ')') { inner += '<span class="f5ext-paren">' + ch + '</span>'; i += 1; continue; }
      if (ch === '.' || ch === ',') { inner += '<span class="f5ext-tok-op">' + ch + '</span>'; i += 1; continue; }
      if (ch >= '0' && ch <= '9') {
        var j = i;
        while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
        var num = s.slice(i, j);
        if (idIndex && num.length >= 3 && idIndex[num]) {
          inner += '<span class="f5ext-tok-num f5ext-idhint f5ext-idhint--inner" data-id="' + escapeHtml(num) + '">' + num + '</span>';
        } else {
          inner += '<span class="f5ext-tok-num">' + num + '</span>';
        }
        i = j; continue;
      }
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
        var k = i;
        while (k < s.length && ((s[k] >= 'a' && s[k] <= 'z') || (s[k] >= 'A' && s[k] <= 'Z') || s[k] === '_')) k++;
        var word = s.slice(i, k);
        var cls = 'f5ext-tok-id';
        var lw = word.toLowerCase();
        if (lw === 'lead' || lw === 'leads' || lw === 'contact' || lw === 'contacts'
            || lw === 'company' || lw === 'companies' || lw === 'client'
            || lw === 'catalogelement' || lw === 'date' || lw === 'random'
            || lw === 'users' || lw === 'user') {
          cls = 'f5ext-tok-ent';
        } else if (lw === 'cf' || lw === 'cfm' || lw === 'cff' || lw === 'sf'
            || lw === 'cfyur' || lw === 'previouscf') {
          cls = 'f5ext-tok-fn';
        }
        inner += '<span class="' + cls + '">' + escapeHtml(word) + '</span>';
        i = k; continue;
      }
      inner += escapeHtml(ch);
      i += 1;
    }
    return inner;
  }

  function renderMirrorHtml(text, refs, resolveLabel, opts) {
    text = (text || '').toString();
    refs = refs || [];
    opts = opts || {};
    var idIndex = opts.idIndex || null;

    var refByStart = {};
    for (var rI = 0; rI < refs.length; rI++) {
      var rr = refs[rI];
      if (!rr || rr.index == null) continue;
      if (refByStart[rr.index] == null) refByStart[rr.index] = rr;
    }

    function isAlphaUnderscore(ch) {
      return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
    }

    // Рендерит подстроку text[from, to). Используется рекурсивно для содержимого скобок
    // модификатора, чтобы вложенные ссылки на переменные ({{lead.sale}} внутри :if(...))
    // тоже становились интерактивными.
    function renderRange(from, to) {
      var out = '';
      var i = from;
      while (i < to) {
        var ref = refByStart[i];
        if (ref && (ref.index + (ref.original ? ref.original.length : 0)) <= to) {
          if (ref.kind === 'idhint') {
            out += '<span class="f5ext-idhint" '
              + 'data-id="' + escapeHtml(ref.fieldId) + '" '
              + 'data-original="' + escapeHtml(ref.original) + '">'
              + escapeHtml(ref.original) + '</span>';
            i += ref.original.length;
            continue;
          }
          if (ref.kind === 'system') {
            var sysHelp = getSystemVarHelp(ref.rootEntity, ref.path);
            var sysClass = sysHelp ? ' is-known' : ' is-unknown';
            var sysAttrs = 'data-root="' + escapeHtml(ref.rootEntity) + '" '
              + 'data-path="' + escapeHtml(ref.path) + '" '
              + 'data-args="' + escapeHtml(ref.fnArgs || '') + '" '
              + 'data-original="' + escapeHtml(ref.original) + '"';
            if (sysHelp) {
              sysAttrs += ' data-desc="' + escapeHtml(sysHelp.desc || '') + '"';
              if (sysHelp.example) sysAttrs += ' data-example="' + escapeHtml(sysHelp.example) + '"';
            }
            out += '<span class="f5ext-sysvar' + sysClass + '" ' + sysAttrs + '>'
              + renderRefInner(ref, idIndex) + '</span>';
            i += ref.original.length;
            continue;
          }

          var resolved = resolveLabel ? resolveLabel(ref) : null;
          var isResolved = !!(resolved && resolved.label);
          var label = isResolved ? resolved.label : '';
          var type = (resolved && resolved.type) ? resolved.type : '';
          var typeRu = type ? fieldTypeLabel(type) : '';
          var resolvedClass = isResolved ? ' is-resolved' : ' is-unknown';
          out += '<span class="f5ext-var' + resolvedClass + '" '
            + 'data-entity="' + escapeHtml(ref.entityKey) + '" '
            + 'data-field-id="' + escapeHtml(ref.fieldId) + '" '
            + 'data-original="' + escapeHtml(ref.original) + '" '
            + 'data-label="' + escapeHtml(label) + '" '
            + 'data-type="' + escapeHtml(typeRu) + '" '
            + 'data-expanded="0">'
            + renderRefInner(ref, idIndex) + '</span>';
          i += ref.original.length;
          continue;
        }

        var ch = text[i];
        var next = (i + 1 < to) ? text[i + 1] : '';

        if (ch === '{' && next === '{') {
          out += '<span class="f5ext-brace">{{</span>';
          i += 2; continue;
        }
        if (ch === '}' && next === '}') {
          out += '<span class="f5ext-brace">}}</span>';
          i += 2; continue;
        }
        if (ch === '(' || ch === ')') {
          out += '<span class="f5ext-paren">' + escapeHtml(ch) + '</span>';
          i += 1; continue;
        }

        if (ch === ':' && isAlphaUnderscore(next)) {
          var j = i + 1;
          while (j < to && isAlphaUnderscore(text[j])) j++;
          var modName = text.slice(i + 1, j);
          var rawArgs = '';
          var argsInnerHtml = '';
          if (j < to && text[j] === '(') {
            var k = j + 1;
            var depth = 1;
            while (k < to && depth > 0) {
              if (text[k] === '(') depth++;
              else if (text[k] === ')') depth--;
              if (depth > 0) k++;
            }
            if (k < to && text[k] === ')') {
              rawArgs = text.slice(j, k + 1);
              argsInnerHtml = renderRange(j + 1, k);
              j = k + 1;
            }
          }
          var help = getModifierHelp(modName);
          var modCls = help ? 'f5ext-mod is-known' : 'f5ext-mod is-unknown';
          out += '<span class="' + modCls + '" '
            + 'data-mod="' + escapeHtml(modName) + '" '
            + 'data-args="' + escapeHtml(rawArgs) + '">'
            + '<span class="f5ext-mod-name">' + escapeHtml(':' + modName) + '</span>'
            + (rawArgs
                ? '<span class="f5ext-paren">(</span>' + argsInnerHtml + '<span class="f5ext-paren">)</span>'
                : '')
            + '</span>';
          i = j;
          continue;
        }

        var start = i;
        i += 1;
        while (i < to) {
          if (refByStart[i]) break;
          var c = text[i];
          var n = (i + 1 < to) ? text[i + 1] : '';
          if ((c === '{' && n === '{') || (c === '}' && n === '}')) break;
          if (c === '(' || c === ')') break;
          if (c === ':' && isAlphaUnderscore(n)) break;
          i += 1;
        }
        out += escapeHtml(text.slice(start, i));
      }
      return out;
    }

    return renderRange(0, text.length) || '&nbsp;';
  }

  global.F5VRParser = {
    extractFieldRefs: extractFieldRefs,
    normalizeEntityToken: normalizeEntityToken,
    entityLabel: entityLabel,
    fieldTypeLabel: fieldTypeLabel,
    getModifierHelp: getModifierHelp,
    getSystemVarHelp: getSystemVarHelp,
    listSystemVars: listSystemVars,
    escapeHtml: escapeHtml,
    renderMirrorHtml: renderMirrorHtml
  };
})(typeof window !== 'undefined' ? window : self);
