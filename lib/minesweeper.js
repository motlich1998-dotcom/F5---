/**
 * Сапёр — пресеты 16×16, 32×32, 64×64.
 * window.F5VRMinesweeper.create(mountEl, options?)
 */
(function (global) {
  'use strict';

  var PRESETS = {
    '16': { rows: 16, cols: 16, mines: 40, label: '16×16' },
    '32': { rows: 32, cols: 32, mines: 160, label: '32×32' },
    '64': { rows: 64, cols: 64, mines: 640, label: '64×64' }
  };
  var DEFAULT_PRESET = '16';

  function normalizePresetKey(key) {
    var s = String(key || '').trim();
    return PRESETS[s] ? s : DEFAULT_PRESET;
  }

  function cellSizeFor(cols) {
    if (cols <= 16) return 24;
    if (cols <= 32) return 16;
    return 10;
  }

  function MinesweeperGame(mountEl, options) {
    options = options || {};
    this.mountEl = mountEl;
    this.presetKey = normalizePresetKey(options.preset || options.boardSize);
    this.onPresetChange = typeof options.onPresetChange === 'function' ? options.onPresetChange : null;
    this._applyPreset(this.presetKey, false);
    this.board = [];
    this.picture = [];
    this.tiles = [];
    this.remaining = 0;
    this.revealed = 0;
    this.ended = false;
    this.toolbarEl = null;
    this.sizeSelect = null;
    this.statusEl = null;
    this.gridEl = null;
    this._buildShell();
    this.init();
  }

  MinesweeperGame.prototype._applyPreset = function (key, updateSelect) {
    var preset = PRESETS[normalizePresetKey(key)];
    this.presetKey = normalizePresetKey(key);
    this.rows = preset.rows;
    this.cols = preset.cols;
    this.mines = preset.mines;
    this.cellSize = cellSizeFor(this.cols);
    if (updateSelect && this.sizeSelect) {
      this.sizeSelect.value = this.presetKey;
    }
  };

  MinesweeperGame.prototype.getPanelWidth = function () {
    return this.cols * this.cellSize + 4;
  };

  MinesweeperGame.prototype._buildShell = function () {
    var self = this;
    this.mountEl.innerHTML = '';
    this.mountEl.classList.add('f5ext-ms-game');

    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'f5ext-ms-toolbar';

    var label = document.createElement('label');
    label.className = 'f5ext-ms-size-label';
    label.textContent = 'Поле:';

    this.sizeSelect = document.createElement('select');
    this.sizeSelect.className = 'f5ext-ms-size';
    Object.keys(PRESETS).forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = PRESETS[key].label + ' (' + PRESETS[key].mines + ' мин)';
      if (key === self.presetKey) opt.selected = true;
      self.sizeSelect.appendChild(opt);
    });
    this.sizeSelect.addEventListener('change', function () {
      var next = normalizePresetKey(self.sizeSelect.value);
      if (next === self.presetKey) return;
      if (self.onPresetChange) {
        self.onPresetChange(next);
      } else {
        self.applyPreset(next);
      }
    });

    label.appendChild(this.sizeSelect);
    this.toolbarEl.appendChild(label);

    this.statusEl = document.createElement('button');
    this.statusEl.type = 'button';
    this.statusEl.className = 'f5ext-ms-status';
    this.statusEl.addEventListener('click', function () {
      if (self.statusEl.classList.contains('is-restart')) self.init();
    });

    this.gridEl = document.createElement('div');
    this.gridEl.className = 'f5ext-ms-grid';
    this.gridEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    this._syncGridMetrics();

    this.mountEl.appendChild(this.toolbarEl);
    this.mountEl.appendChild(this.statusEl);
    this.mountEl.appendChild(this.gridEl);
  };

  MinesweeperGame.prototype._syncGridMetrics = function () {
    this.gridEl.style.setProperty('--ms-cell', this.cellSize + 'px');
    this.gridEl.style.gridTemplateColumns = 'repeat(' + this.cols + ', ' + this.cellSize + 'px)';
    var fontSize = this.cellSize <= 12 ? 9 : (this.cellSize <= 16 ? 11 : 14);
    this.gridEl.style.setProperty('--ms-font', fontSize + 'px');
  };

  MinesweeperGame.prototype.applyPreset = function (key) {
    this._applyPreset(key, true);
    this._syncGridMetrics();
    this.init();
  };

  MinesweeperGame.prototype.check = function (row, col) {
    if (col >= 0 && row >= 0 && col < this.cols && row < this.rows) {
      return this.board[row][col];
    }
    return undefined;
  };

  MinesweeperGame.prototype._setStatus = function (html, restartable) {
    this.statusEl.innerHTML = html;
    this.statusEl.classList.toggle('is-restart', !!restartable);
  };

  MinesweeperGame.prototype.init = function () {
    this.ended = false;
    this.remaining = this.mines;
    this.revealed = 0;
    this._setStatus('Кликайте по клеткам, чтобы открыть. ПКМ — флаг / ?');
    this.gridEl.innerHTML = '';
    this._syncGridMetrics();

    this.board = [];
    this.picture = [];
    this.tiles = [];

    var r;
    for (r = 0; r < this.rows; r++) {
      this.board[r] = new Array(this.cols);
      this.picture[r] = new Array(this.cols);
      this.tiles[r] = new Array(this.cols);
    }

    for (r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'f5ext-ms-cell is-hidden';
        tile.dataset.row = String(r);
        tile.dataset.col = String(c);
        tile.addEventListener('mousedown', this._click.bind(this));
        this.gridEl.appendChild(tile);
        this.tiles[r][c] = tile;
        this.picture[r][c] = 'hidden';
        this.board[r][c] = '';
      }
    }

    var placed = 0;
    while (placed < this.mines) {
      var col = Math.floor(Math.random() * this.cols);
      var row = Math.floor(Math.random() * this.rows);
      if (this.board[row][col] !== 'mine') {
        this.board[row][col] = 'mine';
        placed++;
      }
    }

    for (c = 0; c < this.cols; c++) {
      for (r = 0; r < this.rows; r++) {
        if (this.check(r, c) !== 'mine') {
          this.board[r][c] =
            ((this.check(r + 1, c) === 'mine') | 0) +
            ((this.check(r + 1, c - 1) === 'mine') | 0) +
            ((this.check(r + 1, c + 1) === 'mine') | 0) +
            ((this.check(r - 1, c) === 'mine') | 0) +
            ((this.check(r - 1, c - 1) === 'mine') | 0) +
            ((this.check(r - 1, c + 1) === 'mine') | 0) +
            ((this.check(r, c - 1) === 'mine') | 0) +
            ((this.check(r, c + 1) === 'mine') | 0);
        }
      }
    }
  };

  MinesweeperGame.prototype._paintCell = function (row, col) {
    var tile = this.tiles[row][col];
    var pic = this.picture[row][col];
    tile.className = 'f5ext-ms-cell';
    tile.textContent = '';

    if (pic === 'hidden') {
      tile.classList.add('is-hidden');
      return;
    }
    if (pic === 'flag') {
      tile.classList.add('is-flag');
      tile.textContent = '🚩';
      return;
    }
    if (pic === 'question') {
      tile.classList.add('is-question');
      tile.textContent = '?';
      return;
    }
    if (pic === 'mine') {
      tile.classList.add('is-mine');
      tile.textContent = '💣';
      return;
    }
    if (pic === 'misplaced') {
      tile.classList.add('is-misplaced');
      tile.textContent = '✕';
      return;
    }

    tile.classList.add('is-open');
    if (pic === 0) {
      tile.classList.add('is-n0');
    } else {
      tile.classList.add('is-n' + pic);
      tile.textContent = String(pic);
    }
  };

  MinesweeperGame.prototype._click = function (event) {
    if (this.ended) return;

    var tile = event.currentTarget;
    var row = parseInt(tile.dataset.row, 10);
    var col = parseInt(tile.dataset.col, 10);

    if (event.button === 2) {
      switch (this.picture[row][col]) {
        case 'hidden':
          this.picture[row][col] = 'flag';
          this.remaining--;
          break;
        case 'flag':
          this.picture[row][col] = 'question';
          this.remaining++;
          break;
        case 'question':
          this.picture[row][col] = 'hidden';
          break;
      }
      this._paintCell(row, col);
      event.preventDefault();
    }

    this._setStatus('Мин осталось: ' + this.remaining);

    if (event.button === 0 && this.picture[row][col] !== 'flag') {
      if (this.board[row][col] === 'mine') {
        this.ended = true;
        for (var r = 0; r < this.rows; r++) {
          for (var c = 0; c < this.cols; c++) {
            if (this.board[r][c] === 'mine') {
              this.picture[r][c] = 'mine';
            }
            if (this.board[r][c] !== 'mine' && this.picture[r][c] === 'flag') {
              this.picture[r][c] = 'misplaced';
            }
            this._paintCell(r, c);
          }
        }
        this._setStatus('Игра окончена.<br><br>Нажмите, чтобы начать заново', true);
      } else if (this.picture[row][col] === 'hidden' || this.picture[row][col] === 'question') {
        this.reveal(row, col);
      }
    }

    if (!this.ended && this.revealed === this.rows * this.cols - this.mines) {
      this.ended = true;
      this._setStatus('Победа!<br><br>Нажмите, чтобы начать заново', true);
    }
  };

  MinesweeperGame.prototype.reveal = function (row, col) {
    if (this.picture[row][col] !== 'hidden' && this.picture[row][col] !== 'question') return;

    this.picture[row][col] = this.board[row][col];
    if (this.board[row][col] !== 'mine') this.revealed++;
    this._paintCell(row, col);

    if (this.board[row][col] === 0) {
      if (col > 0 && this.picture[row][col - 1] === 'hidden') this.reveal(row, col - 1);
      if (col < this.cols - 1 && this.picture[row][col + 1] === 'hidden') this.reveal(row, col + 1);
      if (row < this.rows - 1 && this.picture[row + 1][col] === 'hidden') this.reveal(row + 1, col);
      if (row > 0 && this.picture[row - 1][col] === 'hidden') this.reveal(row - 1, col);
      if (col > 0 && row > 0 && this.picture[row - 1][col - 1] === 'hidden') this.reveal(row - 1, col - 1);
      if (col > 0 && row < this.rows - 1 && this.picture[row + 1][col - 1] === 'hidden') this.reveal(row + 1, col - 1);
      if (col < this.cols - 1 && row < this.rows - 1 && this.picture[row + 1][col + 1] === 'hidden') this.reveal(row + 1, col + 1);
      if (col < this.cols - 1 && row > 0 && this.picture[row - 1][col + 1] === 'hidden') this.reveal(row - 1, col + 1);
    }
  };

  MinesweeperGame.prototype.destroy = function () {
    if (this.mountEl) this.mountEl.innerHTML = '';
  };

  global.F5VRMinesweeper = {
    PRESETS: PRESETS,
    DEFAULT_PRESET: DEFAULT_PRESET,
    normalizePresetKey: normalizePresetKey,
    presetOptions: function (key) {
      var k = normalizePresetKey(key);
      var p = PRESETS[k];
      return { preset: k, boardSize: k, rows: p.rows, cols: p.cols, mines: p.mines };
    },
    create: function (mountEl, options) {
      return new MinesweeperGame(mountEl, options || {});
    }
  };
})(typeof window !== 'undefined' ? window : self);
