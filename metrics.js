/*
 * metrics.js - 現像結果を数値で測る
 *
 * 目視では1枚しか見られず、再現性もない。ここで定義した指標は
 * 言語にも環境にも依存しないので、
 *   - UI でのライブ表示
 *   - CLI での一括検証
 *   - 将来 Go や C に移植したときの回帰テスト(同じ数字が出れば移植成功)
 * すべてで同じものを使う。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StarMetrics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function LUM(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
  function pct(arr, p) {
    var a = Float64Array.from(arr); a.sort();
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))];
  }
  function med(arr) { return pct(arr, 0.5); }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / Math.max(1, a.length); }
  function sd(a) { var m = mean(a), s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return Math.sqrt(s / Math.max(1, a.length)); }

  /* 格子ごとの「素の空」。色ムラの検出に使う */
  function grid(rgba, w, h, G, p) {
    var cw = Math.floor(w / G), ch = Math.floor(h / G), out = [];
    for (var gy = 0; gy < G; gy++) {
      for (var gx = 0; gx < G; gx++) {
        var b0 = [], b1 = [], b2 = [];
        var yEnd = Math.min(h, (gy + 1) * ch), xEnd = Math.min(w, (gx + 1) * cw);
        for (var y = gy * ch; y < yEnd; y += 4) {
          for (var x = gx * cw; x < xEnd; x += 4) {
            var q = (y * w + x) * 4;
            b0.push(rgba[q]); b1.push(rgba[q + 1]); b2.push(rgba[q + 2]);
          }
        }
        if (b0.length < 8) continue;
        out.push({
          r: pct(b0, p), g: pct(b1, p), b: pct(b2, p),
          nx: (gx + 0.5) / G * 2 - 1, ny: (gy + 0.5) / G * 2 - 1
        });
      }
    }
    return out;
  }

  /* countStars: 星の検出は全画素走査で重いので、UI では false にできる */
  function measure(rgba, w, h, countStars) {
    var n = w * h, M = {};

    /* --- 背景レベルと色の中立性 --- */
    var step = Math.max(1, Math.floor(n / 300000));
    var R = [], G_ = [], B = [], L = [];
    for (var i = 0; i < n; i += step) {
      var q = i * 4;
      R.push(rgba[q]); G_.push(rgba[q + 1]); B.push(rgba[q + 2]);
      L.push(LUM(rgba[q], rgba[q + 1], rgba[q + 2]));
    }
    var bgR = med(R), bgG = med(G_), bgB = med(B), bgL = med(L);
    M.bgLevel = +bgL.toFixed(1);
    M.colorCast = +Math.max(Math.abs(bgR - bgG), Math.abs(bgB - bgG)).toFixed(2);

    /* --- 背景ノイズ (MAD) --- */
    var dev = [];
    for (var d = 0; d < L.length; d++) dev.push(Math.abs(L[d] - bgL));
    M.noise = +(med(dev) * 1.4826).toFixed(2);

    /* --- 黒潰れ / 白飛び --- */
    var lo = 0, hi = 0, ns = 0;
    for (var i2 = 0; i2 < n; i2 += step) {
      var q2 = i2 * 4; ns++;
      if (rgba[q2] === 0 && rgba[q2 + 1] === 0 && rgba[q2 + 2] === 0) lo++;
      if (rgba[q2] >= 254 || rgba[q2 + 1] >= 254 || rgba[q2 + 2] >= 254) hi++;
    }
    M.clipLow = +(lo / ns * 100).toFixed(3);
    M.clipHigh = +(hi / ns * 100).toFixed(3);

    /* --- 色ムラ: 周辺と中央で「空の色」がどれだけズレるか ---
       マゼンタのリングや四隅の色転びはこの値に出る。実際の空は画面内で
       そんなに色が変わらないので、大きい値は処理の破綻を意味する。 */
    var g = grid(rgba, w, h, 24, 0.20);
    var rg = [], bg2 = [], cenR = [], cenB = [], corR = [], corB = [];
    for (var k = 0; k < g.length; k++) {
      var c = g[k], u = c.nx * c.nx + c.ny * c.ny;
      var dRG = c.r - c.g, dBG = c.b - c.g;
      rg.push(dRG); bg2.push(dBG);
      if (u < 0.15) { cenR.push(dRG); cenB.push(dBG); }
      if (u > 1.1) { corR.push(dRG); corB.push(dBG); }
    }
    M.colorSpread = +Math.max(sd(rg), sd(bg2)).toFixed(2);
    M.cornerCast = (cenR.length && corR.length)
      ? +Math.max(Math.abs(mean(corR) - mean(cenR)), Math.abs(mean(corB) - mean(cenB))).toFixed(2)
      : null;

    /* --- 構造コントラスト: 天の川が背景からどれだけ立っているか --- */
    var cellL = [];
    for (var k2 = 0; k2 < g.length; k2++) cellL.push(LUM(g[k2].r, g[k2].g, g[k2].b));
    M.structure = +((pct(cellL, 0.90) + 1) / (pct(cellL, 0.10) + 1)).toFixed(2);

    /* --- 星の検出 ---
       検出数は「引き出せた情報量」の目安になるが、閾値が背景+5σ なので
       ノイズが減ると閾値も下がり、数が跳ね上がる。単独では信用できない
       (黒を潰した画像で 3128 -> 39920 に化けるのを実測した)。
       そこで星の太さ(FWHM)も測る。こちらは天体写真で標準的に使われる量で、
       ぼかしでも肥大でも増える。過処理の検出にはこちらが効く。 */
    if (countStars === false) {
      M.stars = null; M.starsPerMpx = null; M.fwhm = null; M.eccentricity = null;
      return M;
    }
    var thr = bgL + 5 * (M.noise || 1), stars = 0;
    var lumAt = function (x, y) { var q = (y * w + x) * 4; return LUM(rgba[q], rgba[q + 1], rgba[q + 2]); };
    var fw = [], ecc = [], MAXM = 4000;
    for (var y2 = 1; y2 < h - 1; y2++) {
      var row = y2 * w;
      for (var x2 = 1; x2 < w - 1; x2++) {
        var p0 = (row + x2) * 4;
        var v = LUM(rgba[p0], rgba[p0 + 1], rgba[p0 + 2]);
        if (v <= thr) continue;
        var pl = (row + x2 - 1) * 4, pr = (row + x2 + 1) * 4;
        var pu = (row - w + x2) * 4, pd = (row + w + x2) * 4;
        if (!(v >= LUM(rgba[pl], rgba[pl + 1], rgba[pl + 2]) &&
              v > LUM(rgba[pr], rgba[pr + 1], rgba[pr + 2]) &&
              v >= LUM(rgba[pu], rgba[pu + 1], rgba[pu + 2]) &&
              v > LUM(rgba[pd], rgba[pd + 1], rgba[pd + 2]))) continue;
        stars++;
        // 明るい星だけを測る。淡い星はノイズに埋もれて幅が不安定になる。
        if (fw.length >= MAXM || v < bgL + 12 * (M.noise || 1)) continue;
        if (x2 < 9 || y2 < 9 || x2 >= w - 9 || y2 >= h - 9) continue;
        var half = (v + bgL) / 2, i2b;
        var xl = 0; for (i2b = 1; i2b <= 8; i2b++) { if (lumAt(x2 - i2b, y2) < half) break; xl = i2b; }
        var xr = 0; for (i2b = 1; i2b <= 8; i2b++) { if (lumAt(x2 + i2b, y2) < half) break; xr = i2b; }
        var yu = 0; for (i2b = 1; i2b <= 8; i2b++) { if (lumAt(x2, y2 - i2b) < half) break; yu = i2b; }
        var yd = 0; for (i2b = 1; i2b <= 8; i2b++) { if (lumAt(x2, y2 + i2b) < half) break; yd = i2b; }
        var wx = xl + xr + 1, wy = yu + yd + 1;
        /* 星は「点」なので、少し離れれば背景まで落ちる。
           雲や地上の構造物は明るい面なので落ちない。これを条件に入れないと
           船や雲を星として測ってしまう(IMG_0324 で 13px、IMG_0325 で 17px と
           出るのを実測した)。 */
        if (wx > 9 || wy > 9) continue;
        var far = (lumAt(x2 - 8, y2) + lumAt(x2 + 8, y2) + lumAt(x2, y2 - 8) + lumAt(x2, y2 + 8)) / 4;
        if (far > bgL + (v - bgL) * 0.25) continue;   // 周りも明るい = 面であって星ではない
        fw.push((wx + wy) / 2);
        ecc.push(Math.abs(wx - wy) / (wx + wy));
      }
    }
    M.stars = stars;
    M.starsPerMpx = +(stars / (n / 1e6)).toFixed(0);
    M.fwhm = fw.length >= 20 ? +med(fw).toFixed(2) : null;         // 星の太さ(画素)
    M.eccentricity = ecc.length >= 20 ? +med(ecc).toFixed(3) : null; // 星の伸び(0=真円)
    M.measuredStars = fw.length;
    return M;
  }

  return { measure: measure };
});
