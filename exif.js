/*
 * exif.js - 撮影情報の読み取り（依存なし）
 *
 * JPEG は APP1 セグメント、HEIC は ISOBMFF の中に置かれた Exif ブロックを
 * 探して TIFF 構造を読む。どちらも中身は同じ TIFF なので、入口だけ違う。
 *
 * 星景写真では露出時間と ISO が決定的で、「なぜこの画像は復元できないのか」
 * の説明になることが多い。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StarExif = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAGS = {
    0x010F: 'Make', 0x0110: 'Model', 0x0112: 'Orientation',
    0x829A: 'ExposureTime', 0x829D: 'FNumber', 0x8827: 'ISO',
    0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
    0x920A: 'FocalLength', 0xA405: 'FocalLengthIn35mm',
    0xA434: 'LensModel', 0x8769: 'ExifIFD'
  };

  /* TIFF ヘッダ("II*\0" か "MM\0*")の位置を探す。
     JPEG も HEIC も、この手前に "Exif\0\0" が置かれている。 */
  function findTiff(buf) {
    var u = new Uint8Array(buf), n = Math.min(u.length, 4 * 1024 * 1024);
    for (var i = 0; i < n - 8; i++) {
      if (u[i] === 0x45 && u[i + 1] === 0x78 && u[i + 2] === 0x69 && u[i + 3] === 0x66 &&
          u[i + 4] === 0x00 && u[i + 5] === 0x00) {
        var t = i + 6;
        if ((u[t] === 0x49 && u[t + 1] === 0x49) || (u[t] === 0x4D && u[t + 1] === 0x4D)) return t;
      }
    }
    return -1;
  }

  function readValue(dv, le, type, count, off, tiff) {
    var size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
    var total = size * count;
    var p = total > 4 ? tiff + dv.getUint32(off + 8, le) : off + 8;
    if (p < 0 || p + total > dv.byteLength) return null;
    if (type === 2) {                       // ASCII
      var s = '';
      for (var i = 0; i < count; i++) {
        var c = dv.getUint8(p + i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    }
    if (type === 3) return dv.getUint16(p, le);
    if (type === 4) return dv.getUint32(p, le);
    if (type === 5 || type === 10) {        // 有理数
      var num = type === 5 ? dv.getUint32(p, le) : dv.getInt32(p, le);
      var den = type === 5 ? dv.getUint32(p + 4, le) : dv.getInt32(p + 4, le);
      return den ? num / den : null;
    }
    if (type === 9) return dv.getInt32(p, le);
    return dv.getUint8(p);
  }

  function readIFD(dv, le, tiff, ifd, out) {
    if (ifd + 2 > dv.byteLength) return;
    var n = dv.getUint16(ifd, le);
    if (n > 512) return;                     // 壊れたデータで暴走させない
    for (var i = 0; i < n; i++) {
      var off = ifd + 2 + i * 12;
      if (off + 12 > dv.byteLength) return;
      var tag = dv.getUint16(off, le);
      var name = TAGS[tag];
      if (!name) continue;
      var v = readValue(dv, le, dv.getUint16(off + 2, le), dv.getUint32(off + 4, le), off, tiff);
      if (v === null) continue;
      if (name === 'ExifIFD') readIFD(dv, le, tiff, tiff + v, out);
      else if (out[name] === undefined) out[name] = v;
    }
  }

  function parse(buf) {
    try {
      var tiff = findTiff(buf);
      if (tiff < 0) return null;
      var dv = new DataView(buf);
      var le = dv.getUint8(tiff) === 0x49;
      if (dv.getUint16(tiff + 2, le) !== 42) return null;
      var out = {};
      readIFD(dv, le, tiff, tiff + dv.getUint32(tiff + 4, le), out);
      return Object.keys(out).length ? out : null;
    } catch (e) { return null; }
  }

  /* 表示用の整形。露出は 1/60 のような分数で見せる方が読みやすい。 */
  function format(e) {
    if (!e) return null;
    var o = {};
    if (e.DateTimeOriginal) o['撮影日時'] = String(e.DateTimeOriginal).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1/$2/$3');
    if (e.ExposureTime != null) {
      o['露出'] = e.ExposureTime >= 1
        ? (+e.ExposureTime).toFixed(e.ExposureTime >= 10 ? 0 : 1) + ' 秒'
        : '1/' + Math.round(1 / e.ExposureTime) + ' 秒';
    }
    if (e.FNumber != null) o['絞り'] = 'F' + (+e.FNumber).toFixed(1);
    if (e.ISO != null) o['ISO'] = String(e.ISO);
    if (e.FocalLength != null) {
      o['焦点距離'] = (+e.FocalLength).toFixed(1) + ' mm' +
        (e.FocalLengthIn35mm ? '（35mm換算 ' + e.FocalLengthIn35mm + '）' : '');
    }
    var body = [e.Make, e.Model].filter(Boolean).join(' ');
    if (body) o['機種'] = body.replace(/^Apple Apple/, 'Apple');
    if (e.LensModel) o['レンズ'] = e.LensModel;
    return Object.keys(o).length ? o : null;
  }

  return { parse: parse, format: format };
});
