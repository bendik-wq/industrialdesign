/* The masterclass deck's QR code (byte mode, error correction M, versions 1 to 10: up to 213 bytes, plenty for an
   /apply link). No library and no network: the deck page allows only its own scripts. Draws as SVG rects.
   Loaded as a classic script (window.DeckQR) and readable as CommonJS by the tests (test/deck.test.ts). */
(function (root) {
  'use strict';

  // Error correction M, versions 1 to 10: total codewords, error correction codewords per block, blocks.
  var TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  var EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  function utf8(s) {
    var out = [], i, c;
    s = String(s);
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00); }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function gfMul(x, y) {
    var z = 0, i;
    for (i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    var r = [], i, j, root = 1;
    for (i = 0; i < degree - 1; i++) r.push(0);
    r.push(1);
    for (i = 0; i < degree; i++) {
      for (j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
      root = gfMul(root, 2);
    }
    return r;
  }
  function rsRemainder(data, div) {
    var r = div.map(function () { return 0; }), i, k, f;
    for (i = 0; i < data.length; i++) {
      f = data[i] ^ r.shift(); r.push(0);
      for (k = 0; k < div.length; k++) r[k] ^= gfMul(div[k], f);
    }
    return r;
  }

  function dataCapacity(v) { return TOTAL[v] - EC_PER_BLOCK[v] * BLOCKS[v]; }

  /** The codewords for the text: data, padded, split in blocks, error correction added, interleaved. */
  function codewords(bytes) {
    var v, ccBits;
    for (v = 1; v <= 10; v++) { ccBits = v < 10 ? 8 : 16; if (4 + ccBits + bytes.length * 8 <= dataCapacity(v) * 8) break; }
    if (v > 10) throw new Error('QR: text too long');
    var bits = [], cap = dataCapacity(v) * 8, i;
    function put(val, n) { for (var k = n - 1; k >= 0; k--) bits.push((val >>> k) & 1); }
    put(4, 4); put(bytes.length, ccBits);
    for (i = 0; i < bytes.length; i++) put(bytes[i], 8);
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    var data = [];
    for (i = 0; i < bits.length; i += 8) { var b = 0; for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k]; data.push(b); }
    for (var pad = 0xec; data.length < cap / 8; pad ^= 0xec ^ 0x11) data.push(pad);
    // Blocks: the short ones first, the long ones (one more data codeword) after.
    var nb = BLOCKS[v], ec = EC_PER_BLOCK[v], short = Math.floor(TOTAL[v] / nb), nShort = nb - TOTAL[v] % nb;
    var div = rsDivisor(ec), blocks = [], eccs = [], off = 0;
    for (i = 0; i < nb; i++) {
      var len = short - ec + (i < nShort ? 0 : 1);
      var blk = data.slice(off, off + len); off += len;
      blocks.push(blk); eccs.push(rsRemainder(blk, div));
    }
    var out = [], maxLen = short - ec + 1;
    for (i = 0; i < maxLen; i++) for (var j = 0; j < nb; j++) if (i < blocks[j].length) out.push(blocks[j][i]);
    for (i = 0; i < ec; i++) for (j = 0; j < nb; j++) out.push(eccs[j][i]);
    return { version: v, words: out };
  }

  function MASK(m, x, y) {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  /** The module matrix: rows of booleans (true = dark), without the quiet zone. */
  function encode(text) {
    var cw = codewords(utf8(text)), v = cw.version, size = 17 + 4 * v;
    var mod = [], fn = [], x, y, i, j;
    for (y = 0; y < size; y++) { mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function set(px, py, dark) { mod[py][px] = !!dark; fn[py][px] = true; }
    for (i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var al = ALIGN[v], last = al.length - 1;
    for (i = 0; i < al.length; i++) for (j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    function format(mask) {
      var data = (0 << 3) | mask, rem = data; // error correction M = 00
      for (var k = 0; k < 10; k++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412, bit = function (n) { return (bits >>> n) & 1; };
      for (k = 0; k <= 5; k++) set(8, k, bit(k));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (k = 9; k < 15; k++) set(14 - k, 8, bit(k));
      for (k = 0; k < 8; k++) set(size - 1 - k, 8, bit(k));
      for (k = 8; k < 15; k++) set(8, size - 15 + k, bit(k));
      set(8, size - 8, true);
    }
    format(0);
    if (v >= 7) {
      var rem = v;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      var vb = (v << 12) | rem;
      for (i = 0; i < 18; i++) { var c = (vb >>> i) & 1, a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, c); set(b, a, c); }
    }
    // Data, in the zigzag from the bottom right, skipping the vertical timing column.
    var n = 0, words = cw.words;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
        x = right - j; var up = ((right + 1) & 2) === 0; y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && n < words.length * 8) { mod[y][x] = ((words[n >>> 3] >>> (7 - (n & 7))) & 1) === 1; n++; }
      }
    }
    function applyMask(m) { for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (!fn[y][x] && MASK(m, x, y)) mod[y][x] = !mod[y][x]; }
    function penalty() {
      var p = 0, dark = 0, run, k, line;
      for (var pass = 0; pass < 2; pass++) for (i = 0; i < size; i++) {
        line = []; for (k = 0; k < size; k++) line.push(pass ? mod[k][i] : mod[i][k]);
        run = 1;
        for (k = 1; k <= size; k++) {
          if (k < size && line[k] === line[k - 1]) run++;
          else { if (run >= 5) p += 3 + run - 5; run = 1; }
        }
        var s = line.map(function (d) { return d ? '1' : '0'; }).join('');
        var re = /(?=(10111010000|00001011101))/g;
        while (re.exec(s)) { p += 40; re.lastIndex++; }
      }
      for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
        var c0 = mod[y][x];
        if (c0 === mod[y][x + 1] && c0 === mod[y + 1][x] && c0 === mod[y + 1][x + 1]) p += 3;
      }
      for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (mod[y][x]) dark++;
      var total = size * size;
      p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return p;
    }
    var best = 0, bestP = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m); format(m);
      var pp = penalty();
      if (pp < bestP) { bestP = pp; best = m; }
      applyMask(m);
    }
    applyMask(best); format(best);
    return { version: v, size: size, mask: best, modules: mod };
  }

  /** An SVG string: dark modules as one path, a 4-module quiet zone, sized by the caller's CSS. */
  function svg(text, opts) {
    opts = opts || {};
    var q = encode(text), b = 4, s = q.size + b * 2, d = '';
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) if (q.modules[y][x]) d += 'M' + (x + b) + ' ' + (y + b) + 'h1v1h-1z';
    return '<svg class="' + (opts.cls || 'qr') + '" viewBox="0 0 ' + s + ' ' + s + '" shape-rendering="crispEdges" role="img" aria-label="' + String(opts.label || 'QR code').replace(/"/g, '&quot;') + '">' +
      '<rect width="' + s + '" height="' + s + '" fill="' + (opts.light || '#f7f6f3') + '"/><path d="' + d + '" fill="' + (opts.dark || '#111111') + '"/></svg>';
  }

  var api = { encode: encode, svg: svg, utf8: utf8 };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeckQR = api;
})(typeof self !== 'undefined' ? self : this);
