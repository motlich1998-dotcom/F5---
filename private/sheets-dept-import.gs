/**
 * Google Apps Script — выгрузка «Часы отдела» из API разноски.
 *
 * ВАЖНО: в проекте Apps Script все .gs файлы — одна общая область.
 * Переменные и функции здесь с префиксом F5CH_/f5ch — не пересекаются со старым
 * «Автообновления.gs» (ENGINEERS, loadClosedHours и т.д.).
 *
 * Если оставляете оба скрипта: в своём onOpen добавьте вызов f5chInstallMenu();
 *
 * 1. Откройте целевую Google-таблицу.
 * 2. Расширения → Apps Script → вставьте этот код (отдельный файл или замена).
 * 3. Задайте F5CH_IMPORT_SECRET (тот же токен, что в настройках расширения).
 * 4. Развернуть → Управление развертываниями → ✏️ → Новая версия → Развернуть.
 * 5. Скопируйте URL /exec в настройки расширения.
 * 6. Проверка: откройте URL в браузере → {"ok":true,"message":"Closed hours import v2 is alive."}
 *
 * При ручном импорте из расширения передаются token и raznoskaId —
 * они сохраняются в ScriptProperties и используются при автообновлении.
 */

var F5CH_IMPORT_SECRET = 'замените-на-свой-секрет';
var F5CH_DEFAULT_SHEET_NAME = 'Часы отдела';

var F5CH_ENGINEERS = [
  'Роман Федоров',
  'Сергеев Роман',
  'Маколкин Максим',
  'Губкин Алексей'
];

var F5CH_API_BASE = 'http://147.45.164.13:3242/api/raznoskas';

var F5CH_CONFIG_KEYS = {
  TOKEN: 'F5_CLOSED_HOURS_TOKEN',
  RAZNOSKA_ID: 'F5_CLOSED_HOURS_RAZNOSKA_ID',
  SHEET_TAB: 'F5_CLOSED_HOURS_SHEET_TAB'
};

// --- Web app ---

function doPost(e) {
  try {
    var payload = f5chParsePayload_(e);
    if (String(payload.secret || '') !== String(F5CH_IMPORT_SECRET)) {
      return f5chJsonResponse_({ ok: false, error: 'Неверный секретный токен.' });
    }

    var action = String(payload.action || '').trim();
    if (action === 'sync') {
      return f5chJsonResponse_(f5chHandleSyncRequest_(payload));
    }

    return f5chJsonResponse_({ ok: false, error: 'Неизвестное действие: ' + action });
  } catch (err) {
    console.error('doPost error: %s', err && err.message ? err.message : err);
    return f5chJsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet() {
  return f5chJsonResponse_({ ok: true, message: 'Closed hours import v2 is alive.' });
}

function f5chParsePayload_(e) {
  if (e && e.parameter && e.parameter.payload) {
    return JSON.parse(String(e.parameter.payload));
  }
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Пустой запрос.');
  }
  var ct = String(e.postData.type || '').toLowerCase();
  if (ct.indexOf('application/x-www-form-urlencoded') !== -1 && e.parameter && e.parameter.payload) {
    return JSON.parse(String(e.parameter.payload));
  }
  return JSON.parse(e.postData.contents);
}

function f5chJsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// --- Config ---

function f5chGetConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    token: String(props.getProperty(F5CH_CONFIG_KEYS.TOKEN) || '').trim(),
    raznoskaId: String(props.getProperty(F5CH_CONFIG_KEYS.RAZNOSKA_ID) || '').trim(),
    sheetTab: String(props.getProperty(F5CH_CONFIG_KEYS.SHEET_TAB) || F5CH_DEFAULT_SHEET_NAME).trim() || F5CH_DEFAULT_SHEET_NAME
  };
}

function f5chSaveConfig_(data) {
  var props = PropertiesService.getScriptProperties();
  if (data.token) {
    props.setProperty(F5CH_CONFIG_KEYS.TOKEN, String(data.token).trim());
  }
  if (data.raznoskaId) {
    props.setProperty(F5CH_CONFIG_KEYS.RAZNOSKA_ID, String(data.raznoskaId).trim());
  }
  var sheetTab = String(data.sheetTab || F5CH_DEFAULT_SHEET_NAME).trim() || F5CH_DEFAULT_SHEET_NAME;
  props.setProperty(F5CH_CONFIG_KEYS.SHEET_TAB, sheetTab);
}

// --- Sync handler ---

function f5chHandleSyncRequest_(payload) {
  if (!payload.token) {
    throw new Error('Не передан token.');
  }
  if (!payload.raznoskaId) {
    throw new Error('Не передан raznoskaId.');
  }

  f5chSaveConfig_({
    token: payload.token,
    raznoskaId: payload.raznoskaId,
    sheetTab: payload.sheetTab || F5CH_DEFAULT_SHEET_NAME
  });

  f5chEnsureHourlyTrigger_();
  f5chScheduleImmediateSync_();

  return {
    ok: true,
    message: 'Настройки сохранены. Таблица обновится в течение минуты.',
    raznoskaId: String(payload.raznoskaId),
    scheduled: true
  };
}

// --- Main load ---

function f5chLoadClosedHours(opts) {
  opts = opts || {};

  try {
    var config = f5chGetConfig_();
    if (!config.token) {
      throw new Error('Не настроен token. Выполните импорт из расширения.');
    }
    if (!config.raznoskaId) {
      throw new Error('Не настроен raznoskaId. Выполните импорт из расширения.');
    }

    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = f5chGetOrCreateSheet_(spreadsheet, config.sheetTab);
    var url = f5chBuildApiUrl_(config.raznoskaId);

    var response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + config.token,
        Accept: 'application/json'
      },
      muteHttpExceptions: true,
      followRedirects: true
    });

    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    if (responseCode < 200 || responseCode >= 300) {
      throw new Error(
        'API вернул HTTP ' + responseCode + ': ' + responseText.slice(0, 2000)
      );
    }

    var json;
    try {
      json = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('Ошибка разбора JSON: %s', parseErr.message);
      throw new Error('Не удалось разобрать ответ API как JSON: ' + parseErr.message);
    }

    if (!json || !Array.isArray(json.data)) {
      throw new Error('В ответе API отсутствует массив data.');
    }

    var rows = json.data;
    var matchedRows = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!Array.isArray(row) || row.length <= 22) {
        continue;
      }

      var matched = false;
      for (var j = 0; j < F5CH_ENGINEERS.length; j++) {
        if (f5chIsSameEngineer_(row[21], F5CH_ENGINEERS[j])) {
          matched = true;
          break;
        }
      }

      if (matched) {
        matchedRows.push(row);
      }
    }

    var result = matchedRows.map(function (row) {
      return [
        f5chPrepareDate_(row[1]),
        f5chPrepareValue_(row[3]),
        f5chPrepareValue_(row[4]),
        f5chPrepareValue_(row[5]),
        f5chPrepareNumber_(row[20]),
        f5chPrepareValue_(row[21]),
        f5chPrepareValue_(row[22])
      ];
    });

    result.sort(function (a, b) {
      var engineerCompare = String(a[5]).localeCompare(String(b[5]), 'ru');
      if (engineerCompare !== 0) {
        return engineerCompare;
      }
      return f5chCompareDates_(a[0], b[0]);
    });

    f5chWriteResult_(sheet, result);

    var message = 'Получено: ' + rows.length + '. Записано: ' + result.length + '.';

    if (!opts.silent) {
      spreadsheet.toast(message, 'Выгрузка завершена', 8);
    }

    return {
      ok: true,
      message: message,
      rowCount: result.length,
      apiRowCount: rows.length,
      sheetTab: config.sheetTab,
      raznoskaId: config.raznoskaId
    };
  } catch (error) {
    console.error('Ошибка выгрузки: %s', error.message);
    console.error('Stack trace: %s', error.stack);

    if (!opts.silent) {
      SpreadsheetApp.getActiveSpreadsheet().toast(
        error.message,
        'Ошибка выгрузки',
        10
      );
    }

    throw error;
  }
}

// --- Helpers ---

function f5chGetOrCreateSheet_(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  return sheet;
}

function f5chBuildApiUrl_(raznoskaId) {
  var params = {
    page: 1,
    limit: 50000,
    t: Date.now(),
    isDepartmentView: true
  };

  var queryParts = [];
  for (var key in params) {
    if (params.hasOwnProperty(key)) {
      queryParts.push(
        encodeURIComponent(key) + '=' + encodeURIComponent(params[key])
      );
    }
  }

  return F5CH_API_BASE + '/' + encodeURIComponent(raznoskaId) + '/data?' + queryParts.join('&');
}

function f5chNormalizeText_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value
      .map(function (item) { return f5chNormalizeText_(item); })
      .filter(Boolean)
      .join(', ');
  }

  if (typeof value === 'object') {
    var possibleName =
      value.name ||
      value.fullName ||
      value.full_name ||
      value.title ||
      value.label ||
      value.value;

    if (possibleName !== undefined) {
      return f5chNormalizeText_(possibleName);
    }

    return JSON.stringify(value)
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  return String(value)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/ё/g, 'е')
    .toLowerCase();
}

function f5chPrepareValue_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value
      .map(function (item) {
        if (typeof item === 'object' && item !== null) {
          return item.name || item.title || JSON.stringify(item);
        }
        return item;
      })
      .join(', ');
  }

  if (typeof value === 'object') {
    return value.name ||
      value.fullName ||
      value.full_name ||
      value.title ||
      value.label ||
      JSON.stringify(value);
  }

  return value;
}

function f5chPrepareNumber_(value) {
  if (typeof value === 'number') {
    return value;
  }

  if (value === null || value === undefined || value === '') {
    return '';
  }

  var normalized = String(value)
    .trim()
    .replace(/\s+/g, '')
    .replace(',', '.');

  var number = Number(normalized);
  return Number.isFinite(number) ? number : value;
}

function f5chPrepareDate_(value) {
  if (!value) {
    return '';
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'number') {
    var timestamp = value < 100000000000 ? value * 1000 : value;
    var dateFromNumber = new Date(timestamp);
    return isNaN(dateFromNumber.getTime()) ? value : dateFromNumber;
  }

  var text = String(value).trim();
  var match = text.match(
    /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );

  if (match) {
    var day = match[1];
    var month = match[2];
    var year = match[3];
    var hour = match[4] || 0;
    var minute = match[5] || 0;
    var second = match[6] || 0;

    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
  }

  var parsedDate = new Date(text);
  return isNaN(parsedDate.getTime()) ? value : parsedDate;
}

function f5chCompareDates_(first, second) {
  var firstTime = first instanceof Date ? first.getTime() : new Date(first).getTime();
  var secondTime = second instanceof Date ? second.getTime() : new Date(second).getTime();

  if (isNaN(firstTime) && isNaN(secondTime)) {
    return 0;
  }
  if (isNaN(firstTime)) {
    return 1;
  }
  if (isNaN(secondTime)) {
    return -1;
  }

  return firstTime - secondTime;
}

function f5chWriteResult_(sheet, result) {
  var columnsCount = 7;

  var headers = [
    'Дата оплаты',
    'Наименование организации',
    'Менеджер, принявший оплату',
    'Номер документа оплаты',
    'Количество проданных часов',
    'Кому закрыты часы',
    'Отдел менеджера'
  ];

  var groupColors = [
    '#d9ead3',
    '#cfe2f3',
    '#fff2cc',
    '#ead1dc',
    '#d9d2e9',
    '#fce5cd'
  ];

  sheet.clear();

  sheet
    .getRange(1, 1, 1, columnsCount)
    .setValues([headers])
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#434343')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);

  sheet.setRowHeight(1, 42);
  sheet.setFrozenRows(1);

  if (result.length === 0) {
    sheet.getRange(2, 1).setValue('По выбранным инженерам данных не найдено.');
    console.warn('В таблицу нечего записывать: result пуст.');
    return;
  }

  var groups = new Map();

  result.forEach(function (row) {
    var engineer = String(row[5] || 'Инженер не указан').trim();
    if (!groups.has(engineer)) {
      groups.set(engineer, []);
    }
    groups.get(engineer).push(row);
  });

  var orderedEngineerNames = [];

  F5CH_ENGINEERS.forEach(function (configuredEngineer) {
    var foundGroupName = null;
    groups.forEach(function (rows, groupName) {
      if (!foundGroupName && f5chIsSameEngineer_(groupName, configuredEngineer)) {
        foundGroupName = groupName;
      }
    });

    if (foundGroupName && orderedEngineerNames.indexOf(foundGroupName) === -1) {
      orderedEngineerNames.push(foundGroupName);
    }
  });

  groups.forEach(function (rows, engineerName) {
    if (orderedEngineerNames.indexOf(engineerName) === -1) {
      orderedEngineerNames.push(engineerName);
    }
  });

  var currentRow = 2;

  orderedEngineerNames.forEach(function (engineerName, groupIndex) {
    var engineerRows = groups.get(engineerName);
    if (!engineerRows || engineerRows.length === 0) {
      return;
    }

    var backgroundColor = groupColors[groupIndex % groupColors.length];

    engineerRows.sort(function (first, second) {
      return f5chCompareDates_(first[0], second[0]);
    });

    var totalHours = engineerRows.reduce(function (sum, row) {
      var hours = Number(row[4]);
      return sum + (Number.isFinite(hours) ? hours : 0);
    }, 0);

    sheet
      .getRange(currentRow, 1, 1, columnsCount)
      .merge()
      .setValue(
        engineerName + ' — записей: ' + engineerRows.length + ', часов: ' + f5chFormatHours_(totalHours)
      )
      .setFontWeight('bold')
      .setFontSize(12)
      .setBackground(backgroundColor)
      .setHorizontalAlignment('left')
      .setVerticalAlignment('middle');

    sheet.setRowHeight(currentRow, 30);
    currentRow++;

    sheet
      .getRange(currentRow, 1, engineerRows.length, columnsCount)
      .setValues(engineerRows)
      .setVerticalAlignment('middle');

    sheet
      .getRange(currentRow, 1, engineerRows.length, 1)
      .setNumberFormat('dd.MM.yyyy');

    sheet
      .getRange(currentRow, 5, engineerRows.length, 1)
      .setNumberFormat('0.00');

    sheet
      .getRange(currentRow, 1, engineerRows.length, columnsCount)
      .setBackground(f5chLightenGroupColor_(groupIndex));

    sheet
      .getRange(currentRow, 1, engineerRows.length, columnsCount)
      .setBorder(
        true,
        true,
        true,
        true,
        true,
        true,
        '#d9d9d9',
        SpreadsheetApp.BorderStyle.SOLID
      );

    currentRow += engineerRows.length;

    sheet
      .getRange(currentRow, 1, 1, 4)
      .merge()
      .setValue('Итого по инженеру ' + engineerName)
      .setFontWeight('bold')
      .setHorizontalAlignment('right')
      .setBackground(backgroundColor);

    sheet
      .getRange(currentRow, 5)
      .setValue(totalHours)
      .setNumberFormat('0.00')
      .setFontWeight('bold')
      .setBackground(backgroundColor);

    sheet
      .getRange(currentRow, 6, 1, 2)
      .setBackground(backgroundColor);

    sheet
      .getRange(currentRow, 1, 1, columnsCount)
      .setBorder(
        true,
        true,
        true,
        true,
        false,
        false,
        '#999999',
        SpreadsheetApp.BorderStyle.SOLID_MEDIUM
      );

    currentRow++;
    sheet.setRowHeight(currentRow, 12);
    currentRow++;
  });

  var grandTotalHours = result.reduce(function (sum, row) {
    var hours = Number(row[4]);
    return sum + (Number.isFinite(hours) ? hours : 0);
  }, 0);

  sheet
    .getRange(currentRow, 1, 1, 4)
    .merge()
    .setValue('ОБЩИЙ ИТОГ')
    .setFontWeight('bold')
    .setFontSize(12)
    .setHorizontalAlignment('right')
    .setBackground('#434343')
    .setFontColor('#ffffff');

  sheet
    .getRange(currentRow, 5)
    .setValue(grandTotalHours)
    .setNumberFormat('0.00')
    .setFontWeight('bold')
    .setFontSize(12)
    .setBackground('#434343')
    .setFontColor('#ffffff');

  sheet
    .getRange(currentRow, 6, 1, 2)
    .setBackground('#434343');

  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(3, 220);
  sheet.setColumnWidth(4, 180);
  sheet.setColumnWidth(5, 140);
  sheet.setColumnWidth(6, 220);
  sheet.setColumnWidth(7, 220);

  sheet
    .getRange(1, 1, currentRow, columnsCount)
    .setWrap(true);
}

function f5chFormatHours_(hours) {
  return Number(hours).toFixed(2).replace('.', ',');
}

function f5chLightenGroupColor_(groupIndex) {
  var lightColors = [
    '#f3f8f1',
    '#f1f7fb',
    '#fffaf0',
    '#fcf4f8',
    '#f7f4fa',
    '#fff7f0'
  ];

  return lightColors[groupIndex % lightColors.length];
}

function f5chIsSameEngineer_(apiValue, configuredEngineer) {
  var apiText = f5chNormalizeText_(apiValue);
  var configuredText = f5chNormalizeText_(configuredEngineer);

  if (!apiText || !configuredText) {
    return false;
  }

  if (apiText === configuredText) {
    return true;
  }

  if (apiText.indexOf(configuredText) !== -1 || configuredText.indexOf(apiText) !== -1) {
    return true;
  }

  var apiWords = apiText
    .split(/[\s,;]+/)
    .filter(Boolean)
    .sort();

  var configuredWords = configuredText
    .split(/[\s,;]+/)
    .filter(Boolean)
    .sort();

  return apiWords.join('|') === configuredWords.join('|');
}

// --- Triggers and menu ---

function f5chDeleteDeferredSyncTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'f5chLoadClosedHoursDeferred_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function f5chScheduleImmediateSync_() {
  f5chDeleteDeferredSyncTriggers_();
  ScriptApp.newTrigger('f5chLoadClosedHoursDeferred_')
    .timeBased()
    .at(new Date(Date.now() + 15 * 1000))
    .create();
}

function f5chLoadClosedHoursDeferred_() {
  f5chDeleteDeferredSyncTriggers_();
  f5chLoadClosedHours({ silent: true });
}

function f5chCreateHourlyTrigger_(quiet) {
  f5chDeleteHourlyTriggers();
  ScriptApp.newTrigger('f5chLoadClosedHours')
    .timeBased()
    .everyHours(1)
    .create();

  if (!quiet) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Автообновление каждый час включено.',
      'Часы отдела',
      5
    );
  }
}

function f5chCreateHourlyTrigger() {
  f5chCreateHourlyTrigger_(false);
}

function f5chDeleteHourlyTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;

  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'f5chLoadClosedHours') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }

  if (removed) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Автообновление отключено.',
      'Часы отдела',
      5
    );
  }
}

function f5chEnsureHourlyTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'f5chLoadClosedHours') {
      return;
    }
  }
  f5chCreateHourlyTrigger_(true);
}

function f5chInstallMenu() {
  SpreadsheetApp.getUi()
    .createMenu('Часы отдела')
    .addItem('Обновить сейчас', 'f5chLoadClosedHours')
    .addSeparator()
    .addItem('Настроить обновление каждый час', 'f5chCreateHourlyTrigger')
    .addItem('Удалить автообновление', 'f5chDeleteHourlyTriggers')
    .addToUi();
}
