/**
 * Google Apps Script для импорта разноски отдела.
 *
 * 1. Откройте целевую Google-таблицу.
 * 2. Расширения → Apps Script → вставьте этот код.
 * 3. Задайте IMPORT_SECRET (тот же токен, что в настройках расширения).
 * 4. Развернуть → Новое развертывание → Веб-приложение:
 *    - выполнять от имени: Я
 *    - доступ: Все
 * 5. Скопируйте URL /exec в настройки расширения.
 */

var IMPORT_SECRET = 'замените-на-свой-секрет';
var DEFAULT_SHEET_TAB = 'Разноска';

function doPost(e) {
  try {
    var payload = parsePayload_(e);
    if (String(payload.secret || '') !== String(IMPORT_SECRET)) {
      return jsonResponse_({ ok: false, error: 'Неверный секретный токен.' });
    }
    var result = writeDepartmentImport_(payload);
    return jsonResponse_(result);
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet() {
  return jsonResponse_({ ok: true, message: 'Sheets dept import endpoint is alive.' });
}

function parsePayload_(e) {
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

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function normalizeName_(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseHours_(value) {
  var n = Number(String(value || '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function writeDepartmentImport_(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabName = String(data.sheetTab || DEFAULT_SHEET_TAB || 'Разноска').trim() || DEFAULT_SHEET_TAB;
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) sheet = ss.insertSheet(tabName);
  sheet.clear();

  var headers = Array.isArray(data.headers) && data.headers.length
    ? data.headers
    : ['Дата', 'Контрагент', 'Создатель счета', 'Часов к начислению', 'Начислено сотруднику'];
  var colCount = headers.length;
  var employees = Array.isArray(data.employees) ? data.employees : [];
  var allRows = Array.isArray(data.rows) ? data.rows : [];
  var row = 1;

  sheet.getRange(row, 1, 1, colCount).merge()
    .setValue(String(data.title || 'Разноска отдела'))
    .setFontWeight('bold')
    .setFontSize(14)
    .setBackground('#dbeafe')
    .setHorizontalAlignment('left');
  row++;

  sheet.getRange(row, 1, 1, colCount).merge()
    .setValue('Обновлено: ' + Utilities.formatDate(new Date(), 'Europe/Moscow', 'dd.MM.yyyy HH:mm'))
    .setFontColor('#64748b')
    .setFontSize(10);
  row += 2;

  var headerRow = row;
  sheet.getRange(row, 1, 1, colCount).setValues([headers])
    .setFontWeight('bold')
    .setBackground('#e8eef7')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  row++;

  var dataStartRow = row;
  var writtenRows = 0;
  var grandTotal = 0;

  employees.forEach(function (employeeName) {
    var empKey = normalizeName_(employeeName);
    var empRows = allRows.filter(function (cells) {
      return normalizeName_(cells[4]) === empKey;
    });
    if (!empRows.length) return;

    sheet.getRange(row, 1, 1, colCount).merge()
      .setValue(employeeName)
      .setFontWeight('bold')
      .setBackground('#f1f5f9')
      .setFontColor('#0f172a');
    row++;

    var values = empRows.map(function (cells) {
      var next = cells.slice(0, colCount);
      while (next.length < colCount) next.push('');
      if (next.length > 3) next[3] = parseHours_(next[3]);
      return next;
    });
    sheet.getRange(row, 1, values.length, colCount).setValues(values);
    row += values.length;
    writtenRows += values.length;

    var subtotal = empRows.reduce(function (sum, cells) {
      return sum + parseHours_(cells[3]);
    }, 0);
    grandTotal += subtotal;

    var subtotalRow = ['', '', 'Итого · ' + employeeName, subtotal, ''];
    sheet.getRange(row, 1, 1, colCount).setValues([subtotalRow])
      .setFontWeight('bold')
      .setBackground('#eef2ff');
    sheet.getRange(row, 4).setNumberFormat('#,##0.00');
    row += 2;
  });

  if (!writtenRows) {
    throw new Error('Нет строк для записи.');
  }

  var totalRow = row;
  sheet.getRange(row, 1, 1, colCount).setValues([['', '', 'Итого по отделу', grandTotal, '']])
    .setFontWeight('bold')
    .setBackground('#dbeafe');
  sheet.getRange(row, 4).setNumberFormat('#,##0.00');

  var tableEndRow = totalRow;
  var tableRange = sheet.getRange(headerRow, 1, tableEndRow - headerRow + 1, colCount);
  tableRange.setBorder(true, true, true, true, true, true, '#cbd5e1', SpreadsheetApp.BorderStyle.SOLID);

  if (dataStartRow < totalRow) {
    sheet.getRange(dataStartRow, 4, totalRow - dataStartRow, 1).setNumberFormat('#,##0.00');
    sheet.getRange(dataStartRow, 1, totalRow - dataStartRow, 1).setHorizontalAlignment('center');
    sheet.getRange(dataStartRow, 4, totalRow - dataStartRow, 1).setHorizontalAlignment('right');
  }

  sheet.setFrozenRows(headerRow);
  for (var c = 1; c <= colCount; c++) sheet.autoResizeColumn(c);

  return {
    ok: true,
    message: 'Импортировано на лист «' + tabName + '»',
    rowCount: writtenRows,
    totalHours: grandTotal,
    sheetTab: tabName
  };
}
