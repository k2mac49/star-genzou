/*
 * develop.js - 星景写真の現像コア
 *
 * 依存ライブラリなし / DOM非依存 / Node・ブラウザ両対応。
 * 入出力はどちらも RGBA の Uint8ClampedArray なので、Canvas の ImageData を
 * そのまま渡せるし、他のどんな環境にも載せ替えられる。
 *
 *   const out = StarDevelop.develop(rgba, width, height, params);
 *
 * 処理の流れ:
 *   1. sRGB -> リニア     光の量に戻す。カブリは「足し算」なのでリニアでないと正しく引けない
 *   2. カブリ除去         星を避けて空のグラデーションを多項式で推定し減算
 *   3. 色かぶり中和       RGBの背景レベルを揃える = 黒が「黒」になる
 *   4. リニア -> sRGB     ここから先は見た目の調整なので表示空間で行う
 *   5. 黒点 + ストレッチ   背景を沈め、淡い部分だけ持ち上げる
 *   6. 彩度 / カラーノイズ処理
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StarDevelop = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    gridSize:     28,    // カブリ推定のサンプル格子。粗いほど淡い星雲を残す
    bgPercentile: 0.25,  // 各セルで下位何割を「空」とみなすか。星を除外するため低め
    polyDegree:   1,     // カブリの次数。0=一定 / 1=平面 / 2=お椀 / 3=複雑。上げすぎ注意
    rejectSigma:  2.0,   // 明るい構造(天の川)をサンプルから弾く閾値
    rejectIters:  3,
    neutralize:   1.0,   // 色かぶり中和の強さ 0..1
    shadowK:      2.2,   // 黒点をノイズ何σ下に置くか。大きいほど黒が粘る
    targetBg:     0.10,  // 最終的な背景の明るさ 0..1。小さいほど黒が黒くなる
    saturation:   1.30,
    chromaSmooth: 0,     // カラーノイズ除去の半径(px)。0=off
    vignette:     0,     // 周辺減光の輝度補正 0..1。天の川が中央にあると誤爆するので既定off
    radialColor:  1.0,   // 周辺の色転びの補正 0..1。輝度に触らないので安全
    rejectForeground: 3.0, // 前景除外。彩度が中央値の何倍を超えたら空でないと判定するか
    noiseBudget:  12,    // 出力背景ノイズの上限(0-255)。超えないようストレッチ量を自動調整。0=制限なし
    subClipBudget: 0.05, // 減算で潰してよい画素の割合。小さいほど安全だが色かぶりが残る
    skyMask:      1,     // 地上(前景)を背景モデルから外す。0=off
    /* 背景モデル 0=多項式 / 1=RBF(動径基底関数)
       RBF は Siril や GraXpert が既定で使う現代的な手法で実装して比較したが、
       この用途では多項式に明確に劣った(27枚で悪化 7枚 -> 15枚、周辺色ムラ平均
       6.4 -> 15.3)。RBF の柔軟性は「淡い対象が画面の一部を占める」前提のもので、
       天の川が画面全体を覆う広角一枚撮りでは、天の川そのものを背景として
       吸い込んでしまう。外れ値除去を足しても中心点を減らしても改善しなかった。
       地上が大きく入る1秒露光の写真だけは RBF が勝つが、そちらは露出不足が
       主因なので、モデルを変えても解決しない。 */
    bgModel:      0,
    rbfSmooth:    0.02,  // RBF の平滑化。大きいほど滑らか
    rbfCenters:   180,   // RBF の中心点数。多いほど柔軟だが天の川を消しやすい
    blackDataFloor: 0.40, // 入力画素のこの割合以上が黒潰れなら、復元対象の情報が無いと判断して素通しする
    exposure:     1.00,  // 全体の明るさ微調整
    /* 出力段でのチャンネル別オフセット(0-255)。ヒストグラムを直接つまんで
       動かすための口。色かぶりの手動補正はここで行う。 */
    levelR:       0,
    levelG:       0,
    levelB:       0
  };

  /* ---------- sRGB 変換テーブル ---------- */
  var S2L = new Float32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i / 255;
    S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  var L2S_N = 4096, L2S = new Float32Array(L2S_N + 1);
  for (var j = 0; j <= L2S_N; j++) {
    var v = j / L2S_N;
    L2S[j] = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }
  function lin2srgb(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    var f = v * L2S_N, k = f | 0, t = f - k;
    return L2S[k] * (1 - t) + L2S[k + 1] * t;
  }

  /* ---------- 多項式フィット用の小さな線形代数 ---------- */
  function solve(A, b, n) {
    for (var col = 0; col < n; col++) {
      var piv = col;
      for (var r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-12) continue;
      var tA = A[col]; A[col] = A[piv]; A[piv] = tA;
      var tb = b[col]; b[col] = b[piv]; b[piv] = tb;
      for (var r2 = col + 1; r2 < n; r2++) {
        var f = A[r2][col] / A[col][col];
        if (!f) continue;
        for (var c2 = col; c2 < n; c2++) A[r2][c2] -= f * A[col][c2];
        b[r2] -= f * b[col];
      }
    }
    var x = new Float64Array(n);
    for (var k = n - 1; k >= 0; k--) {
      var s = b[k];
      for (var c3 = k + 1; c3 < n; c3++) s -= A[k][c3] * x[c3];
      x[k] = Math.abs(A[k][k]) < 1e-12 ? 0 : s / A[k][k];
    }
    return x;
  }

  // 正規化座標 (-1..1) での多項式の項。
  // 次数を上げるほど複雑なカブリを表現できるが、上げすぎると天の川そのものを
  // 「カブリ」と誤認して消してしまう。実測上、次数1(平面)で足りることが多い。
  function terms(x, y, deg) {
    var t = [1];
    if (deg >= 1) t.push(x, y);
    if (deg >= 2) t.push(x * x, x * y, y * y);
    if (deg >= 3) t.push(x * x * x, x * x * y, x * y * y, y * y * y);
    return t;
  }
  function nTerms(deg) { return deg >= 3 ? 10 : deg >= 2 ? 6 : deg >= 1 ? 3 : 1; }
  // 係数は常に10要素に揃えておく (減算ループが固定長を前提にしているため)
  function pad10(cf) {
    var out = new Float64Array(10);
    for (var i = 0; i < cf.length && i < 10; i++) out[i] = cf[i];
    return out;
  }

  function fitPoly(pts, deg, rejectSigma, iters) {
    var n = nTerms(deg);
    var use = new Uint8Array(pts.length); use.fill(1);
    var coef = null;
    for (var it = 0; it <= iters; it++) {
      var A = [], b = new Float64Array(n);
      for (var r = 0; r < n; r++) A.push(new Float64Array(n));
      var cnt = 0;
      for (var p = 0; p < pts.length; p++) {
        if (!use[p]) continue;
        cnt++;
        var T = terms(pts[p].x, pts[p].y, deg), val = pts[p].v;
        for (var a = 0; a < n; a++) {
          for (var c = 0; c < n; c++) A[a][c] += T[a] * T[c];
          b[a] += T[a] * val;
        }
      }
      if (cnt < n + 2) break;
      coef = solve(A, b, n);
      if (it === iters) break;
      // 残差を見て、明るい側に外れたサンプル(天の川など)を除外して再フィット
      var res = [], sum = 0;
      for (var p2 = 0; p2 < pts.length; p2++) {
        var T2 = terms(pts[p2].x, pts[p2].y, deg), m = 0;
        for (var a2 = 0; a2 < n; a2++) m += coef[a2] * T2[a2];
        var d = pts[p2].v - m; res.push(d); sum += d * d;
      }
      var sd = Math.sqrt(sum / pts.length) || 1e-9;
      var changed = 0;
      for (var p3 = 0; p3 < pts.length; p3++) {
        var keep = (res[p3] < rejectSigma * sd && res[p3] > -4 * sd) ? 1 : 0;
        if (keep !== use[p3]) changed++;
        use[p3] = keep;
      }
      if (!changed) break;
    }
    return coef;
  }

  function medianOf(arr) {
    var a = Float32Array.from(arr); a.sort();
    var n = a.length;
    return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  /* 格子状に空のサンプルを取る。
     各セルで下位パーセンタイルを拾うことで、星や天の川を避けて「素の空」を得る。 */
  function sampleGrid(lin, width, height, G, pct) {
    var cw = Math.max(1, Math.floor(width / G)), ch = Math.max(1, Math.floor(height / G));
    var step = Math.max(1, Math.floor(Math.sqrt((cw * ch) / 400)));  // 1セルあたり最大400点
    var pts = [[], [], []];
    for (var gy = 0; gy < G; gy++) {
      for (var gx = 0; gx < G; gx++) {
        var x0 = gx * cw, y0 = gy * ch;
        var x1 = Math.min(width, x0 + cw), y1 = Math.min(height, y0 + ch);
        if (x1 <= x0 || y1 <= y0) continue;
        var b0 = [], b1 = [], b2 = [];
        for (var y = y0; y < y1; y += step) {
          for (var x = x0; x < x1; x += step) {
            var idx = (y * width + x) * 3;
            b0.push(lin[idx]); b1.push(lin[idx + 1]); b2.push(lin[idx + 2]);
          }
        }
        if (b0.length < 8) continue;
        var nx = ((x0 + x1) / 2) / width * 2 - 1;
        var ny = ((y0 + y1) / 2) / height * 2 - 1;
        var bufs = [b0, b1, b2];
        for (var c = 0; c < 3; c++) {
          var s = Float32Array.from(bufs[c]); s.sort();
          pts[c].push({
            x: nx, y: ny, gx: gx, gy: gy,
            v: s[Math.min(s.length - 1, Math.floor(pct * s.length))],
            // 上位側も持っておく。星があるかどうかの判定に使う
            hi: s[Math.min(s.length - 1, Math.floor(0.92 * s.length))]
          });
        }
      }
    }
    return pts;
  }

  /* ---------- RBF (動径基底関数) による背景推定 ----------
     多項式は「画面全体を1本の式で表す」ので、単純な傾斜しか扱えない。
     実際の空は光害が複数方向から来たり地上の照り返しが入ったりして、
     1枚の平面やお椀では表現できない (地上入りの構図で失敗する原因がこれ)。

     RBF は観測点ごとに「山」を置いて足し合わせるので局所的な変化を追える。
     Siril や GraXpert が既定で採用している方式。薄板スプライン r^2*log(r) を
     使い、対角に平滑化項を足してノイズに追従しすぎないようにする。 */
  function fitRBF(pts, lambda, maxCenters) {
    var N = pts.length;
    if (N < 8) return null;
    var step = Math.max(1, Math.ceil(N / maxCenters));
    var C = [];
    for (var i = 0; i < N; i += step) C.push(pts[i]);
    var n = C.length, m = n + 3;
    var A = [], b = new Float64Array(m);
    for (var r = 0; r < m; r++) A.push(new Float64Array(m));
    for (var i2 = 0; i2 < n; i2++) {
      for (var j = 0; j < n; j++) {
        var dx = C[i2].x - C[j].x, dy = C[i2].y - C[j].y, r2 = dx * dx + dy * dy;
        A[i2][j] = r2 > 1e-12 ? 0.5 * r2 * Math.log(r2) : 0;
      }
      A[i2][i2] += lambda;                 // 平滑化。大きいほど滑らかになる
      A[i2][n] = 1; A[i2][n + 1] = C[i2].x; A[i2][n + 2] = C[i2].y;
      A[n][i2] = 1; A[n + 1][i2] = C[i2].x; A[n + 2][i2] = C[i2].y;
      b[i2] = C[i2].v;
    }
    var w = solve(A, b, m);
    for (var k = 0; k < m; k++) if (!isFinite(w[k])) return null;
    return { C: C, w: w };
  }

  function evalRBF(md, x, y) {
    var C = md.C, w = md.w, n = C.length;
    var s = w[n] + w[n + 1] * x + w[n + 2] * y;
    for (var i = 0; i < n; i++) {
      var dx = x - C[i].x, dy = y - C[i].y, r2 = dx * dx + dy * dy;
      if (r2 > 1e-12) s += w[i] * 0.5 * r2 * Math.log(r2);
    }
    return s;
  }


  /* RBF に外れ値除去を入れたもの。
     多項式側には最初から入っていたが RBF 側に入れ忘れており、
     天の川を背景として吸い込んでいた。モデルの柔軟性ではなく
     「明るい構造をサンプルから外すかどうか」が効いていた。 */
  function fitRBFRobust(pts, lambda, maxCenters, rejectSigma, iters) {
    var N = pts.length;
    if (N < 12) return null;
    var use = new Uint8Array(N); use.fill(1);
    var md = null;
    for (var it = 0; it <= iters; it++) {
      var kept = [];
      for (var k = 0; k < N; k++) if (use[k]) kept.push(pts[k]);
      if (kept.length < 12) break;
      var cand = fitRBF(kept, lambda, maxCenters);
      if (!cand) break;
      md = cand;
      if (it === iters) break;
      var sum = 0, res = new Float64Array(N);
      for (var p = 0; p < N; p++) {
        res[p] = pts[p].v - evalRBF(md, pts[p].x, pts[p].y);
        sum += res[p] * res[p];
      }
      var sd = Math.sqrt(sum / N) || 1e-12, changed = 0;
      for (var q = 0; q < N; q++) {
        var keep = (res[q] < rejectSigma * sd && res[q] > -4 * sd) ? 1 : 0;
        if (keep !== use[q]) changed++;
        use[q] = keep;
      }
      if (!changed) break;
    }
    return md;
  }

  /* 背景は滑らかなので、粗い格子で評価して線形補間すれば足りる。
     全画素で RBF を評価すると中心点の数だけ掛かって実用速度が出ない。 */
  function rbfToMap(md, GM) {
    var map = new Float32Array(GM * GM);
    for (var gy = 0; gy < GM; gy++) {
      var ny = gy / (GM - 1) * 2 - 1;
      for (var gx = 0; gx < GM; gx++) map[gy * GM + gx] = evalRBF(md, gx / (GM - 1) * 2 - 1, ny);
    }
    return map;
  }

  function sampleMap(map, GM, nx, ny) {
    var fx = (nx + 1) / 2 * (GM - 1), fy = (ny + 1) / 2 * (GM - 1);
    if (fx < 0) fx = 0; else if (fx > GM - 1) fx = GM - 1;
    if (fy < 0) fy = 0; else if (fy > GM - 1) fy = GM - 1;
    var ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    var ix1 = ix + 1 < GM ? ix + 1 : ix, iy1 = iy + 1 < GM ? iy + 1 : iy;
    var a = map[iy * GM + ix], b2 = map[iy * GM + ix1];
    var c = map[iy1 * GM + ix], d = map[iy1 * GM + ix1];
    return (a + (b2 - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }


  /* 地上(前景)と空を分ける。
     地上の見分け方は「星が無く、空より極端に暗いか明るい」。
     ただしそれだけだと天の川の暗黒帯まで地上と誤判定するので、
     画面の端から繋がっている領域だけを地上とみなす。
     空の中に浮かぶ暗い領域は、どの端にも繋がらないので除外されない。 */
  function buildSkyMask(pts, G) {
    var N = pts[0].length;
    if (N < 24) return null;
    var lvl = [], spread = [], chroma = [];
    for (var i = 0; i < N; i++) {
      var r = pts[0][i].v, g = pts[1][i].v, b = pts[2][i].v;
      var l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      var hi = 0.2126 * pts[0][i].hi + 0.7152 * pts[1][i].hi + 0.0722 * pts[2][i].hi;
      lvl.push(l);
      spread.push(hi - l);            // 星があるセルは上位と下位の差が大きい
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      chroma.push(mx > 1e-6 ? (mx - mn) / mx : 0);
    }
    // 星が写っているセルを空の代表とみなして基準の明るさを決める
    var spSorted = Float32Array.from(spread); spSorted.sort();
    var spThr = spSorted[Math.floor(spSorted.length * 0.5)];
    var skyLvls = [];
    for (var k = 0; k < N; k++) if (spread[k] >= spThr) skyLvls.push(lvl[k]);
    if (skyLvls.length < 8) return null;
    var skyLvl = medianOf(skyLvls);
    var chMid = medianOf(chroma);
    if (skyLvl <= 1e-7) return null;

    var ground = new Uint8Array(G * G), present = new Uint8Array(G * G);
    for (var p = 0; p < N; p++) {
      var id = pts[0][p].gy * G + pts[0][p].gx;
      present[id] = 1;
      var dark = lvl[p] < skyLvl * 0.45;
      var bright = lvl[p] > skyLvl * 3.0;
      var colored = chroma[p] > Math.max(0.18, chMid * 3.5);
      if (dark || bright || colored) ground[id] = 1;
    }

    // 端から繋がっている地上候補だけを地上として確定させる
    var keep = new Uint8Array(G * G), stack = [];
    function push(id) { if (id >= 0 && id < G * G && ground[id] && !keep[id]) { keep[id] = 1; stack.push(id); } }
    for (var e = 0; e < G; e++) {
      push((G - 1) * G + e); push(e);           // 下端・上端
      push(e * G); push(e * G + (G - 1));       // 左端・右端
    }
    while (stack.length) {
      var cur = stack.pop(), cx = cur % G, cy = (cur / G) | 0;
      if (cx > 0) push(cur - 1);
      if (cx < G - 1) push(cur + 1);
      if (cy > 0) push(cur - G);
      if (cy < G - 1) push(cur + G);
    }

    var skyCnt = 0, total = 0;
    for (var q = 0; q < G * G; q++) if (present[q]) { total++; if (!keep[q]) skyCnt++; }
    // 空がほとんど残らないなら判定を誤っている。使わない方が安全。
    if (total === 0 || skyCnt / total < 0.25) return null;
    return { ground: keep, G: G, skyRatio: skyCnt / total };
  }

  /* 前景(人工物・地上)をサンプルから除外する。
     空はほぼ無彩色だが、船や建物や照明は彩度が高い。この差で判別する。
     輝度で判別しようとすると天の川まで落ちてしまうので、彩度で見るのが要点。 */
  function rejectForeground(pts, K) {
    var N = pts[0].length, ratio = [];
    for (var i = 0; i < N; i++) {
      var r = pts[0][i].v, g = pts[1][i].v, b = pts[2][i].v;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      ratio.push(mx > 1e-6 ? (mx - mn) / mx : 0);
    }
    var mid = medianOf(ratio);
    var thr = Math.max(0.12, mid * K);
    var out = [[], [], []], dropped = 0;
    for (var k = 0; k < N; k++) {
      if (ratio[k] > thr) { dropped++; continue; }
      for (var c = 0; c < 3; c++) out[c].push(pts[c][k]);
    }
    // 空全体が色付いている場合(強い光害)は除外しすぎないよう諦める
    if (out[0].length < Math.max(12, N * 0.4)) return { pts: pts, dropped: 0 };
    return { pts: out, dropped: dropped };
  }

  /* 黒潰れしたセルをサンプルから除外する。
     撮影時点で既に黒が潰れている画像では、下位パーセンタイルが軒並み0になる。
     そこから色を測ると「存在しない色」を補正してしまい破綻する(実測で確認)。
     測れないものは測れないと認めて、そのセルは使わない。 */
  function rejectClipped(pts, eps) {
    var N = pts[0].length, out = [[], [], []], dropped = 0;
    for (var k = 0; k < N; k++) {
      var r = pts[0][k].v, g = pts[1][k].v, b = pts[2][k].v;
      if (Math.min(r, g, b) <= eps) { dropped++; continue; }
      for (var c = 0; c < 3; c++) out[c].push(pts[c][k]);
    }
    return { pts: out, dropped: dropped, ratio: N ? dropped / N : 0 };
  }

  /* 周辺部の「色」だけを半径方向に補正する。
     レンズの色シェーディングは光軸中心の同心円状に出る。
     輝度まで触ると天の川を減光と誤認して壊すので(実測で確認済み)、
     ここでは G を基準にした色差 R-G / B-G の半径依存だけを取り除く。 */
  function fitRadialColor(pts) {
    var N = pts[0].length, S = [], maxU = 1e-9;
    for (var i = 0; i < N; i++) {
      var p = pts[0][i], u = p.x * p.x + p.y * p.y;
      if (u > maxU) maxU = u;
      S.push({ u: u, dr: pts[0][i].v - pts[1][i].v, db: pts[2][i].v - pts[1][i].v });
    }
    for (var s = 0; s < N; s++) S[s].u /= maxU;
    function fit1(key) {
      var use = new Uint8Array(N); use.fill(1);
      var co = null;
      for (var it = 0; it < 3; it++) {
        var A = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
        var b = new Float64Array(3), cnt = 0;
        for (var k = 0; k < N; k++) {
          if (!use[k]) continue;
          cnt++;
          var T = [1, S[k].u, S[k].u * S[k].u];
          for (var a = 0; a < 3; a++) {
            for (var c2 = 0; c2 < 3; c2++) A[a][c2] += T[a] * T[c2];
            b[a] += T[a] * S[k][key];
          }
        }
        if (cnt < 8) return null;
        co = solve(A, b, 3);
        var sum = 0, res = [];
        for (var k2 = 0; k2 < N; k2++) {
          var m = co[0] + co[1] * S[k2].u + co[2] * S[k2].u * S[k2].u;
          var d = S[k2][key] - m; res.push(d); sum += d * d;
        }
        var sd = Math.sqrt(sum / N) || 1e-9, ch = 0;
        for (var k3 = 0; k3 < N; k3++) {
          var keep = Math.abs(res[k3]) < 2.5 * sd ? 1 : 0;
          if (keep !== use[k3]) ch++;
          use[k3] = keep;
        }
        if (!ch) break;
      }
      return co;
    }
    var cr = fit1('dr'), cb = fit1('db');
    if (!cr || !cb) return null;
    return { cr: cr, cb: cb, maxU: maxU };
  }

  /* 周辺減光の推定。
     減光は光軸を中心とした同心円状だが、天の川は同心円ではない。
     だから「半径だけの関数」に当てはめると、減光の成分だけが分離できる。
     戻り値は v(u)=1+a*u+b*u^2 (u は正規化した半径の2乗) の係数。 */
  function fitRadial(pts) {
    var S = [], maxU = 1e-9;
    for (var i = 0; i < pts[0].length; i++) {
      var p0 = pts[0][i], u = p0.x * p0.x + p0.y * p0.y;
      var lum = 0.2126 * pts[0][i].v + 0.7152 * pts[1][i].v + 0.0722 * pts[2][i].v;
      S.push({ u: u, v: lum });
      if (u > maxU) maxU = u;
    }
    for (var s = 0; s < S.length; s++) S[s].u /= maxU;

    var use = new Uint8Array(S.length); use.fill(1);
    var co = null;
    for (var it = 0; it < 4; it++) {
      var A = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
      var b = new Float64Array(3), cnt = 0;
      for (var k = 0; k < S.length; k++) {
        if (!use[k]) continue;
        cnt++;
        var T = [1, S[k].u, S[k].u * S[k].u];
        for (var a = 0; a < 3; a++) {
          for (var c2 = 0; c2 < 3; c2++) A[a][c2] += T[a] * T[c2];
          b[a] += T[a] * S[k].v;
        }
      }
      if (cnt < 6) break;
      co = solve(A, b, 3);
      // 天の川など明るい側の外れ値を落として再フィット
      var sum = 0;
      for (var k2 = 0; k2 < S.length; k2++) {
        var m = co[0] + co[1] * S[k2].u + co[2] * S[k2].u * S[k2].u;
        var d = S[k2].v - m; S[k2].r = d; sum += d * d;
      }
      var sd = Math.sqrt(sum / S.length) || 1e-9, changed = 0;
      for (var k3 = 0; k3 < S.length; k3++) {
        var keep = (S[k3].r < 1.5 * sd && S[k3].r > -3 * sd) ? 1 : 0;
        if (keep !== use[k3]) changed++;
        use[k3] = keep;
      }
      if (!changed) break;
    }
    if (!co || co[0] <= 1e-7) return null;
    return { a: co[1] / co[0], b: co[2] / co[0], maxU: maxU };
  }

  /* ================================================================
     解析と適用の分離
     ----------------------------------------------------------------
     実測すると、処理時間の大半は画素数に比例しない「解析」だった
     (12.2Mpx で 1241ms、0.8Mpx でも 371ms)。解析は格子サンプリングと
     多項式フィットで、結果はわずか30個ほどの数値。画像ごとに1回でよい。

     スライダーを動かすたびに必要なのは「適用」だけで、これは純粋な
     画素演算 11ms/Mpx。分離しないとスライダー操作が 1241ms かかる。
     ================================================================ */

  function mergeParams(params) {
    var P = {};
    for (var k in DEFAULTS) P[k] = DEFAULTS[k];
    if (params) for (var k2 in params) if (params[k2] !== undefined) P[k2] = params[k2];
    return P;
  }

  /* ---------- 解析: 画像ごとに1回 ---------- */
  function analyze(rgba, width, height, params) {
    var P = mergeParams(params);
    var n = width * height;

    var lin = new Float32Array(n * 3);
    var blackPx = 0;
    for (var i = 0, o = 0; i < n; i++) {
      var q = i * 4;
      var r0 = rgba[q], g0 = rgba[q + 1], b0 = rgba[q + 2];
      if (r0 === 0 || g0 === 0 || b0 === 0) blackPx++;
      lin[o++] = S2L[r0]; lin[o++] = S2L[g0]; lin[o++] = S2L[b0];
    }

    var M = {
      lin: lin, width: width, height: height, n: n,
      blackRatio: blackPx / n, droppedCells: 0, clippedRatio: 0, lowConfidence: false
    };

    /* --- 空のサンプリングと前景・黒潰れセルの除外 --- */
    var G = Math.max(6, P.gridSize | 0);
    var ptsC = sampleGrid(lin, width, height, G, P.bgPercentile);

    /* 地上を背景モデルから外す。
       地上込みで空のカブリを推定すると、山の黒や地上の照明にモデルが
       引きずられて壊れる(地上入りの構図で19枚中9枚が悪化するのを実測した)。 */
    var skyMask = P.skyMask > 0 ? buildSkyMask(ptsC, G) : null;
    /* 撮影時点で画面の大半が真っ黒に潰れている画像には、そもそも復元できる
       情報が無い。無理に持ち上げるとノイズだけが暴れる(入力黒潰れ 45%以上の
       5枚が例外なく破綻するのを実測した)。触らずに返すのが正しい。 */
    if (M.blackRatio > P.blackDataFloor) {
      M.noData = true;
      P.neutralize = 0; P.radialColor = 0; P.polyDegree = 0;
    }
    M.skyRatio = skyMask ? skyMask.skyRatio : 1;
    M.skyMaskUsed = !!skyMask;
    M.mask = skyMask;
    if (skyMask) {
      var kept = [[], [], []];
      for (var sk = 0; sk < ptsC[0].length; sk++) {
        if (skyMask.ground[ptsC[0][sk].gy * G + ptsC[0][sk].gx]) continue;
        for (var sc = 0; sc < 3; sc++) kept[sc].push(ptsC[sc][sk]);
      }
      ptsC = kept;
    }

    if (P.rejectForeground > 0) {
      var rf = rejectForeground(ptsC, P.rejectForeground);
      ptsC = rf.pts; M.droppedCells = rf.dropped;
    }
    var rcl = rejectClipped(ptsC, 1e-5);
    M.clippedRatio = +rcl.ratio.toFixed(3);
    if (rcl.pts[0].length >= Math.max(12, ptsC[0].length * 0.5)) {
      ptsC = rcl.pts;
    } else {
      M.lowConfidence = true;
      P.neutralize = 0; P.radialColor = 0; P.polyDegree = 0;
    }

    if (P.vignette > 0) {
      var vg = fitRadial(ptsC);
      if (vg) {
        for (var vy = 0; vy < height; vy++) {
          var vny = (vy + 0.5) / height * 2 - 1;
          var vrow = vy * width * 3;
          for (var vx = 0; vx < width; vx++) {
            var vnx = (vx + 0.5) / width * 2 - 1;
            var u = (vnx * vnx + vny * vny) / vg.maxU;
            var vv = 1 + vg.a * u + vg.b * u * u;
            if (vv < 0.35) vv = 0.35;
            var gn = 1 + (1 / vv - 1) * P.vignette;
            var vb = vrow + vx * 3;
            lin[vb] *= gn; lin[vb + 1] *= gn; lin[vb + 2] *= gn;
          }
        }
        ptsC = sampleGrid(lin, width, height, G, P.bgPercentile);
        if (P.rejectForeground > 0) ptsC = rejectForeground(ptsC, P.rejectForeground).pts;
      }
    }

    /* --- カブリ(光害の傾斜)の推定 --- */
    var deg = P.polyDegree, nt = nTerms(deg);
    var coefs = [], bgMean = [0, 0, 0], bgLo = [0, 0, 0], bgHi = [0, 0, 0];
    for (var c5 = 0; c5 < 3; c5++) {
      var cf = fitPoly(ptsC[c5], deg, P.rejectSigma, P.rejectIters);
      if (!cf) {
        cf = new Float64Array(1);
        cf[0] = medianOf(ptsC[c5].map(function (p) { return p.v; }));
      }
      cf = pad10(cf);
      coefs.push(cf);
      var sum2 = 0, lo2 = Infinity, hi2 = -Infinity;
      for (var p4 = 0; p4 < ptsC[c5].length; p4++) {
        var T3 = terms(ptsC[c5][p4].x, ptsC[c5][p4].y, deg), m2 = 0;
        for (var a3 = 0; a3 < nt; a3++) m2 += cf[a3] * T3[a3];
        sum2 += m2;
        if (m2 < lo2) lo2 = m2;
        if (m2 > hi2) hi2 = m2;
      }
      bgMean[c5] = sum2 / Math.max(1, ptsC[c5].length);
      /* 空で実際に観測した範囲を覚えておく。
         地上を除いて多項式を当てると、地上の領域はモデルの外挿になる。
         外挿値をそのまま引くと引きすぎて地上が真っ黒に潰れる
         (黒潰れが 0.06% -> 49% になるのを実測した)。観測範囲に留める。 */
      bgLo[c5] = isFinite(lo2) ? lo2 : 0;
      bgHi[c5] = isFinite(hi2) ? hi2 : 0;
    }
    M.coefs = coefs; M.deg = deg; M.bgMean = bgMean; M.bgLo = bgLo; M.bgHi = bgHi;

    /* RBF を使う場合は、多項式の代わりに背景マップを作る。
       係数は使わず、粗い格子に評価した値を線形補間して使う。 */
    M.bgMap = null;
    if (P.bgModel === 1) {
      var GM = 64, maps = [], okRBF = true;
      for (var cm = 0; cm < 3; cm++) {
        var md = fitRBFRobust(ptsC[cm], P.rbfSmooth, P.rbfCenters, P.rejectSigma, P.rejectIters);
        if (!md) { okRBF = false; break; }
        maps.push(rbfToMap(md, GM));
      }
      if (okRBF) {
        M.bgMap = maps; M.GM = GM;
        // 観測した空のセルでの値域と平均を取り直す(外挿を抑えるため)
        for (var cn = 0; cn < 3; cn++) {
          var sum3 = 0, lo3 = Infinity, hi3 = -Infinity;
          for (var pp = 0; pp < ptsC[cn].length; pp++) {
            var vv3 = sampleMap(maps[cn], GM, ptsC[cn][pp].x, ptsC[cn][pp].y);
            sum3 += vv3;
            if (vv3 < lo3) lo3 = vv3;
            if (vv3 > hi3) hi3 = vv3;
          }
          bgMean[cn] = sum3 / Math.max(1, ptsC[cn].length);
          bgLo[cn] = isFinite(lo3) ? lo3 : 0;
          bgHi[cn] = isFinite(hi3) ? hi3 : 0;
        }
      }
    }


    /* --- 色を測れているかの信頼度 ---
       背景が黒潰れの底に貼り付いていると、引き算の結果が 0 で片側だけ
       切り捨てられ、チャンネル間に嘘の差が生まれる (IMG_0325 で色かぶりが
       5 -> 145 に悪化するのを実測)。二値で切り替えると同程度に潰れている
       IMG_0324 が巻き添えになるため、底からの浮き具合に比例させる。 */
    var minBgLevel = 255 * lin2srgb(Math.min(bgMean[0], bgMean[1], bgMean[2]));
    M.confidence = Math.max(0, Math.min(1, (minBgLevel - 2) / 14));
    M.minBgLevel = minBgLevel;

    /* --- 周辺の色転び ---
       格子点だけをカブリ補正した値で半径フィットする。全画素を回す必要はない。
       この補正はゼロ平均なので、中和量(定数シフト)を変えても結果は変わらない。
       つまりスライダーを動かしても再計算不要。 */
    var ptsCorr = [[], [], []];
    for (var pi = 0; pi < ptsC[0].length; pi++) {
      var px = ptsC[0][pi].x, py = ptsC[0][pi].y;
      var Tt = terms(px, py, deg);
      for (var cc = 0; cc < 3; cc++) {
        var bgv = 0;
        for (var ai = 0; ai < nt; ai++) bgv += coefs[cc][ai] * Tt[ai];
        ptsCorr[cc].push({ x: px, y: py, v: ptsC[cc][pi].v - bgv + bgMean[cc] });
      }
    }
    var rc = fitRadialColor(ptsCorr);
    if (rc) {
      /* 基準を中央の色にすると、中央にある天の川の色に画面全体が引きずられて
         中立性が壊れる(実測)。画面全体の平均を基準にしてゼロ平均にする。 */
      var SN = 96, sumR = 0, sumB = 0, cntS = 0;
      for (var sy = 0; sy < SN; sy++) {
        var sny = (sy + 0.5) / SN * 2 - 1;
        for (var sx = 0; sx < SN; sx++) {
          var snx = (sx + 0.5) / SN * 2 - 1;
          var su = (snx * snx + sny * sny) / rc.maxU;
          sumR += rc.cr[0] + rc.cr[1] * su + rc.cr[2] * su * su;
          sumB += rc.cb[0] + rc.cb[1] * su + rc.cb[2] * su * su;
          cntS++;
        }
      }
      rc.e0r = sumR / cntS; rc.e0b = sumB / cntS;
    }
    M.radial = rc;

    /* --- 統計用の画素サンプルを保存 ---
       黒点とノイズの推定は、スライダーを動かすたびに必要になるが、
       全画素を見る必要はない。ここで抜いておけば適用側は数ミリ秒で済む。 */
    // 中央値とノイズの推定に20万点は過剰。2.4万点でも統計誤差は0.6%程度で、
    // ソート2回のコストが1/10になる。適用側の固定費はここが支配的だった。
    /* 黒点とノイズも空だけで測る。黒い山が画面の3割を占めると中央値が
       地上に引きずられ、空が持ち上がりすぎる。 */
    var mcw = Math.max(1, Math.floor(width / G)), mch = Math.max(1, Math.floor(height / G));
    var isSky = function (x, y) {
      if (!skyMask) return true;
      var gx2 = Math.min(G - 1, (x / mcw) | 0), gy2 = Math.min(G - 1, (y / mch) | 0);
      return !skyMask.ground[gy2 * G + gx2];
    };
    var S = Math.min(n, 24000);
    var sstep = Math.max(1, Math.floor(n / S));
    var cnt = 0;
    for (var si = 0; si < n; si += sstep) cnt++;
    var sLin = new Float32Array(cnt * 3), sNx = new Float32Array(cnt), sNy = new Float32Array(cnt);
    var sSky = new Uint8Array(cnt);
    var j = 0;
    for (var si2 = 0; si2 < n && j < cnt; si2 += sstep) {
      var sxp = si2 % width, syp = (si2 / width) | 0;
      sNx[j] = (sxp + 0.5) / width * 2 - 1;
      sNy[j] = (syp + 0.5) / height * 2 - 1;
      sSky[j] = isSky(sxp, syp) ? 1 : 0;
      sLin[j * 3] = lin[si2 * 3]; sLin[j * 3 + 1] = lin[si2 * 3 + 1]; sLin[j * 3 + 2] = lin[si2 * 3 + 2];
      j++;
    }
    M.sSky = sSky;
    M.sLin = sLin; M.sNx = sNx; M.sNy = sNy; M.sCount = cnt;

    /* サンプル位置でのカブリ量と半径をここで確定させておく。
       これらは係数だけで決まりスライダーでは変わらないので、適用側で
       20万点ぶんの多項式を組み直すのは完全な無駄だった。 */
    var sBg = new Float32Array(cnt * 3), sU = new Float32Array(cnt);
    var bA = new Float64Array(3), bB = new Float64Array(3), bC = new Float64Array(3), bD = new Float64Array(3);
    var lastNy = NaN;
    for (var t1 = 0; t1 < cnt; t1++) {
      var tnx = sNx[t1], tny = sNy[t1];
      if (tny !== lastNy) { foldRow(coefs, deg, tny, bA, bB, bC, bD); lastNy = tny; }
      var tn2 = tnx * tnx, tn3 = tn2 * tnx;
      for (var bc = 0; bc < 3; bc++) {
        var bv = M.bgMap
          ? sampleMap(M.bgMap[bc], M.GM, tnx, tny)
          : (bc === 0 ? bA[0] + bB[0] * tnx + bC[0] * tn2 + bD[0] * tn3
           : bc === 1 ? bA[1] + bB[1] * tnx + bC[1] * tn2 + bD[1] * tn3
                      : bA[2] + bB[2] * tnx + bC[2] * tn2 + bD[2] * tn3);
        if (bv < bgLo[bc]) bv = bgLo[bc]; else if (bv > bgHi[bc]) bv = bgHi[bc];
        sBg[t1 * 3 + bc] = bv;
      }
      sU[t1] = rc ? (tn2 + tny * tny) / rc.maxU : 0;
    }
    M.sBg = sBg; M.sU = sU;

    // 減算の上限を引くための、チャンネルごとのソート済みサンプル
    // 減算の上限は空の画素だけで決める(地上の黒を基準にすると引けなくなる)
    var skyN = 0;
    for (var t9 = 0; t9 < cnt; t9++) if (sSky[t9]) skyN++;
    if (skyN < 200) { skyN = cnt; for (var u9 = 0; u9 < cnt; u9++) sSky[u9] = 1; }
    M.sSorted = [];
    for (var c9 = 0; c9 < 3; c9++) {
      var arr = new Float32Array(skyN), w9 = 0;
      for (var q9 = 0; q9 < cnt; q9++) if (sSky[q9]) arr[w9++] = sLin[q9 * 3 + c9];
      arr.sort();
      M.sSorted.push(arr);
    }

    // 適用で使い回す作業バッファ (毎回確保すると GC で揺れる)
    M.work = new Float32Array(n * 3);
    M.out = new Uint8ClampedArray(n * 4);
    return M;
  }

  /* 多項式を行ごとに畳んだ係数。bg = A + B*x + C*x^2 + D*x^3 */
  function foldRow(coefs, deg, ny, A, B, C, D) {
    var ny2 = ny * ny, ny3 = ny2 * ny;
    for (var ci = 0; ci < 3; ci++) {
      var f = coefs[ci];
      A[ci] = f[0] + f[2] * ny + f[5] * ny2;
      B[ci] = f[1] + f[4] * ny;
      C[ci] = f[3];
      D[ci] = 0;
      if (deg >= 3) { A[ci] += f[9] * ny3; B[ci] += f[8] * ny2; C[ci] += f[7] * ny; D[ci] = f[6]; }
    }
  }

  /* ---------- 適用: スライダーを動かすたび ----------
     注意: 戻り値のバッファは呼び出しごとに使い回される。スライダー操作で
     毎回確保すると GC で揺れるため。結果を取っておきたい場合は複製すること。 */
  function apply(M, params, outInfo) {
    var P = mergeParams(params);
    if (M.lowConfidence) { P.neutralize = 0; P.radialColor = 0; }
    var n = M.n, width = M.width, height = M.height;
    var coefs = M.coefs, deg = M.deg, bgMean = M.bgMean;
    var info = {
      blackRatio: +M.blackRatio.toFixed(4), droppedCells: M.droppedCells,
      clippedRatio: M.clippedRatio, lowConfidence: M.lowConfidence,
      confidence: +M.confidence.toFixed(3), minBgLevel: +M.minBgLevel.toFixed(1),
      skyRatio: +(M.skyRatio === undefined ? 1 : M.skyRatio).toFixed(3), skyMaskUsed: !!M.skyMaskUsed
    };

    /* --- 色かぶり中和の量を決める --- */
    var neu = P.neutralize * M.confidence;
    var rcStr = P.radialColor * M.confidence;
    var targetLevel = Math.min(bgMean[0], bgMean[1], bgMean[2]);
    var shift = [0, 0, 0];
    for (var c6 = 0; c6 < 3; c6++) shift[c6] = bgMean[c6] + (targetLevel - bgMean[c6]) * neu;

    /* 引きすぎの上限。潰れた画像では背景推定が実際の空より高く出るため、
       そのまま引くと暗いチャンネルだけ 0 で切り捨てられ色が転ぶ。 */
    for (var c8 = 0; c8 < 3; c8++) {
      var srt = M.sSorted[c8];
      var fl = srt[Math.min(srt.length - 1, Math.floor(srt.length * P.subClipBudget))];
      if (bgMean[c8] - shift[c8] > fl) { shift[c8] = bgMean[c8] - fl; info.subCapped = true; }
    }

    var rc = M.radial, hasRC = !!(rc && rcStr > 0);

    /* --- 黒点とノイズをサンプルから推定 (全画素を見る必要はない) --- */
    var SC = M.sCount, sL = M.sLin, sBg = M.sBg, sU = M.sU;
    var lum = new Float32Array(SC);
    for (var s = 0; s < SC; s++) {
      var s3 = s * 3;
      var v0 = sL[s3] - sBg[s3] + shift[0];
      var v1 = sL[s3 + 1] - sBg[s3 + 1] + shift[1];
      var v2 = sL[s3 + 2] - sBg[s3 + 2] + shift[2];
      if (hasRC) {
        var u = sU[s];
        v0 -= ((rc.cr[0] + rc.cr[1] * u + rc.cr[2] * u * u) - rc.e0r) * rcStr;
        v2 -= ((rc.cb[0] + rc.cb[1] * u + rc.cb[2] * u * u) - rc.e0b) * rcStr;
      }
      lum[s] = 0.2126 * lin2srgb(v0 < 0 ? 0 : v0) + 0.7152 * lin2srgb(v1 < 0 ? 0 : v1) + 0.0722 * lin2srgb(v2 < 0 ? 0 : v2);
    }
    /* 中央値とノイズは空の画素だけで測る。黒い山が画面の3割を占めると
       中央値が地上に引きずられ、空が持ち上がりすぎる。 */
    var sSky = M.sSky, skyLum = [];
    for (var s2 = 0; s2 < SC; s2++) if (!sSky || sSky[s2]) skyLum.push(lum[s2]);
    if (skyLum.length < 200) { skyLum = []; for (var s3 = 0; s3 < SC; s3++) skyLum.push(lum[s3]); }
    var med = medianOf(skyLum);
    var dev = new Float32Array(skyLum.length);
    for (var d2 = 0; d2 < skyLum.length; d2++) dev[d2] = Math.abs(skyLum[d2] - med);
    var mad = medianOf(dev) * 1.4826 || 1e-4;

    var clip = Math.max(0, med - P.shadowK * mad);
    /* ただし黒点は画面全体を見て決める。空だけで決めると、空より暗い地上が
       まるごと 0 に潰れる(黒潰れが 0.06% -> 49% になるのを実測した)。 */
    var lumSorted = Float32Array.from(lum); lumSorted.sort();
    var floorAll = lumSorted[Math.floor(lumSorted.length * 0.004)];
    if (clip > floorAll) clip = Math.max(0, floorAll);
    var span = Math.max(1e-6, 1 - clip);
    var bgAfter = Math.max(1e-6, Math.min(0.999, (med - clip) / span));

    function mForTarget(tt) {
      var mm = (bgAfter * (1 - tt)) / (bgAfter - 2 * tt * bgAfter + tt);
      return Math.min(0.999, Math.max(0.001, mm));
    }
    function gainAt(mm) {   // 背景付近の傾き = ノイズが何倍に拡大されるか
      var dd = (2 * mm - 1) * bgAfter - mm;
      return dd === 0 ? 1 : (mm * (1 - mm)) / (dd * dd);
    }
    var noiseNorm = mad / span;

    /* ノイズ予算による自動制御。固定の targetBg は綺麗な画像なら良いが、
       信号が残っていない画像ではノイズだけ増幅する(実測)。出力ノイズが
       予算を超えない強さまで自動で下げる。 */
    var t = Math.min(0.95, Math.max(0.001, P.targetBg));
    if (P.noiseBudget > 0 && noiseNorm * gainAt(mForTarget(t)) * 255 > P.noiseBudget) {
      var loT = 0.01, hiT = t;
      for (var bs = 0; bs < 24; bs++) {
        var midT = (loT + hiT) / 2;
        if (noiseNorm * gainAt(mForTarget(midT)) * 255 > P.noiseBudget) hiT = midT; else loT = midT;
      }
      t = loT;
    }
    var m3 = mForTarget(t);
    /* 復元対象の情報が無い画像は、黒点もストレッチもかけずそのまま返す。
       中央値も MAD も潰れた 0 の山から出た値で、意味を持たないため。 */
    if (M.noData) { clip = 0; span = 1; m3 = 0.5; t = med; }
    info.noData = !!M.noData;
    // 画像ごとに何が実際に変わっているのかを外から見えるようにしておく
    info.skyMedian = med * 255;          // 空の明るさ(測定値)
    info.skyNoise = mad * 255;           // 空のノイズ(測定値)
    info.blackPoint = clip * 255;        // 決まった黒点
    info.stretchGain = gainAt(m3);       // 背景付近をこの倍率で持ち上げている
    info.targetBgUsed = t;
    info.predictedNoise = noiseNorm * gainAt(m3) * 255;

    /* sRGB変換 -> 黒点 -> ストレッチ -> 露出 は、どれもリニア値ひとつだけの
       関数なので、まとめて1本の表にできる。画素ごとに2回引いていた表引きが
       1回になる。ここが適用側で一番効く最適化。 */
    var CN = 4096, CLUT = new Float32Array(CN + 1);
    for (var ci2 = 0; ci2 <= CN; ci2++) {
      var e = (lin2srgb(ci2 / CN) - clip) / span;
      e = e < 0 ? 0 : e > 1 ? 1 : e;
      var dm = (2 * m3 - 1) * e - m3;
      var vv2 = (e <= 0) ? 0 : (e >= 1) ? 1 : (dm === 0 ? e : ((m3 - 1) * e) / dm);
      vv2 *= P.exposure;
      CLUT[ci2] = vv2 < 0 ? 0 : vv2 > 1 ? 1 : vv2;
    }

    /* --- 全画素を1回だけ通す --- */
    var lin = M.lin, w2 = M.work;
    // x方向の座標と冪は全行で共通。行ごとに作り直すのは無駄だった。
    var BM = M.bgMap, GM2 = M.GM || 0;
    // マップの格子位置は全行で共通なので先に出しておく
    var MIX = null, MIX1 = null, MTX = null;
    if (BM) {
      MIX = new Int32Array(width); MIX1 = new Int32Array(width); MTX = new Float64Array(width);
      for (var mxi = 0; mxi < width; mxi++) {
        var fxm = (mxi + 0.5) / width * (GM2 - 1);
        if (fxm < 0) fxm = 0; else if (fxm > GM2 - 1) fxm = GM2 - 1;
        var ixm = fxm | 0;
        MIX[mxi] = ixm; MIX1[mxi] = ixm + 1 < GM2 ? ixm + 1 : ixm; MTX[mxi] = fxm - ixm;
      }
    }
    var NX = new Float64Array(width), NX2 = new Float64Array(width), NX3 = new Float64Array(width);
    for (var xi = 0; xi < width; xi++) {
      var v = (xi + 0.5) / width * 2 - 1;
      NX[xi] = v; NX2[xi] = v * v; NX3[xi] = v * v * v;
    }
    var rA = new Float64Array(3), rB = new Float64Array(3), rC2 = new Float64Array(3), rD = new Float64Array(3);
    var bgLo = M.bgLo, bgHi = M.bgHi;
    var L0 = bgLo[0], L1 = bgLo[1], L2 = bgLo[2];
    var H0 = bgHi[0], H1 = bgHi[1], H2 = bgHi[2];
    var invMaxU = rc ? 1 / rc.maxU : 0;
    var cr0 = rc ? rc.cr[0] - rc.e0r : 0, cr1 = rc ? rc.cr[1] : 0, cr2 = rc ? rc.cr[2] : 0;
    var cb0 = rc ? rc.cb[0] - rc.e0b : 0, cb1 = rc ? rc.cb[1] : 0, cb2 = rc ? rc.cb[2] : 0;
    for (var yy = 0; yy < height; yy++) {
      var nyr = (yy + 0.5) / height * 2 - 1;
      foldRow(coefs, deg, nyr, rA, rB, rC2, rD);
      var rowA0 = 0, rowB0 = 0, mty = 0, omty = 1;
      if (BM) {
        var fym = (yy + 0.5) / height * (GM2 - 1);
        if (fym < 0) fym = 0; else if (fym > GM2 - 1) fym = GM2 - 1;
        var iym = fym | 0;
        mty = fym - iym; omty = 1 - mty;
        rowA0 = iym * GM2; rowB0 = (iym + 1 < GM2 ? iym + 1 : iym) * GM2;
      }
      var nyr2 = nyr * nyr;
      var A0 = rA[0], B0 = rB[0], C0 = rC2[0], D0 = rD[0];
      var A1 = rA[1], B1 = rB[1], C1 = rC2[1], D1 = rD[1];
      var A2 = rA[2], B2 = rB[2], C2 = rC2[2], D2 = rD[2];
      var s0 = shift[0], s1 = shift[1], s2 = shift[2];
      var rowBase = yy * width * 3;
      for (var xx = 0; xx < width; xx++) {
        var nxr = NX[xx], nxr2 = NX2[xx], nxr3 = NX3[xx];
        var base = rowBase + xx * 3;
        // 空で観測した範囲にモデルを閉じ込める。地上側は外挿になるので、
        // そのまま引くと引きすぎて真っ黒に潰れる。
        var q0, q1, q2c;
        if (BM) {
          var mix = MIX[xx], mix1 = MIX1[xx], mtx = MTX[xx];
          var r0a = BM[0][rowA0 + mix], r0b = BM[0][rowA0 + mix1];
          var r0c = BM[0][rowB0 + mix], r0d = BM[0][rowB0 + mix1];
          q0 = (r0a + (r0b - r0a) * mtx) * omty + (r0c + (r0d - r0c) * mtx) * mty;
          var r1a = BM[1][rowA0 + mix], r1b = BM[1][rowA0 + mix1];
          var r1c = BM[1][rowB0 + mix], r1d = BM[1][rowB0 + mix1];
          q1 = (r1a + (r1b - r1a) * mtx) * omty + (r1c + (r1d - r1c) * mtx) * mty;
          var r2a = BM[2][rowA0 + mix], r2b = BM[2][rowA0 + mix1];
          var r2c2 = BM[2][rowB0 + mix], r2d = BM[2][rowB0 + mix1];
          q2c = (r2a + (r2b - r2a) * mtx) * omty + (r2c2 + (r2d - r2c2) * mtx) * mty;
        } else {
          q0 = A0 + B0 * nxr + C0 * nxr2 + D0 * nxr3;
          q1 = A1 + B1 * nxr + C1 * nxr2 + D1 * nxr3;
          q2c = A2 + B2 * nxr + C2 * nxr2 + D2 * nxr3;
        }
        if (q0 < L0) q0 = L0; else if (q0 > H0) q0 = H0;
        if (q1 < L1) q1 = L1; else if (q1 > H1) q1 = H1;
        if (q2c < L2) q2c = L2; else if (q2c > H2) q2c = H2;
        var a0 = lin[base] - q0 + s0;
        var a1 = lin[base + 1] - q1 + s1;
        var a2 = lin[base + 2] - q2c + s2;
        if (hasRC) {
          var uu = (nxr2 + nyr2) * invMaxU;
          a0 -= (cr0 + cr1 * uu + cr2 * uu * uu) * rcStr;
          a2 -= (cb0 + cb1 * uu + cb2 * uu * uu) * rcStr;
        }
        if (a0 < 0) a0 = 0; else if (a0 > 1) a0 = 1;
        if (a1 < 0) a1 = 0; else if (a1 > 1) a1 = 1;
        if (a2 < 0) a2 = 0; else if (a2 > 1) a2 = 1;
        var g0 = a0 * CN, k0 = g0 | 0, t0 = g0 - k0;
        var g1 = a1 * CN, k1 = g1 | 0, t1 = g1 - k1;
        var g2 = a2 * CN, k2 = g2 | 0, t2 = g2 - k2;
        var o0 = CLUT[k0] + (CLUT[k0 + 1 > CN ? CN : k0 + 1] - CLUT[k0]) * t0;
        var o1 = CLUT[k1] + (CLUT[k1 + 1 > CN ? CN : k1 + 1] - CLUT[k1]) * t1;
        var o2 = CLUT[k2] + (CLUT[k2 + 1 > CN ? CN : k2 + 1] - CLUT[k2]) * t2;
        w2[base] = o0 < 0 ? 0 : o0 > 1 ? 1 : o0;
        w2[base + 1] = o1 < 0 ? 0 : o1 > 1 ? 1 : o1;
        w2[base + 2] = o2 < 0 ? 0 : o2 > 1 ? 1 : o2;
      }
    }

    if (P.chromaSmooth > 0) smoothChroma(w2, width, height, Math.round(P.chromaSmooth));

    var out = M.out, sat = P.saturation;
    var lvR = P.levelR || 0, lvG = P.levelG || 0, lvB = P.levelB || 0;
    for (var i6 = 0; i6 < n; i6++) {
      var b4 = i6 * 3, q2 = i6 * 4;
      var r = w2[b4], g = w2[b4 + 1], bl = w2[b4 + 2];
      if (sat !== 1) {
        var L = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        r = L + (r - L) * sat; g = L + (g - L) * sat; bl = L + (bl - L) * sat;
      }
      out[q2] = r * 255 + lvR; out[q2 + 1] = g * 255 + lvG; out[q2 + 2] = bl * 255 + lvB;
      out[q2 + 3] = 255;
    }
    if (outInfo) for (var ik in info) outInfo[ik] = info[ik];
    return out;
  }

  /* ---------- 便宜ラッパ (CLI と回帰テスト用) ---------- */
  function develop(rgba, width, height, params, outInfo) {
    return apply(analyze(rgba, width, height, params), params, outInfo);
  }

  /* 輝度は保ったまま色差だけを平滑化する = 星や淡い部分のディテールを壊さずに
     カラーノイズだけ消す */
  function smoothChroma(d, w, h, r) {
    var n = w * h;
    var lum = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var b = i * 3;
      lum[i] = 0.2126 * d[b] + 0.7152 * d[b + 1] + 0.0722 * d[b + 2];
    }
    for (var c = 0; c < 3; c++) {
      var ch = new Float32Array(n);
      for (var i2 = 0; i2 < n; i2++) ch[i2] = d[i2 * 3 + c] - lum[i2];
      boxBlur(ch, w, h, r);
      for (var i3 = 0; i3 < n; i3++) {
        var v = lum[i3] + ch[i3];
        d[i3 * 3 + c] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
  }

  function boxBlur(a, w, h, r) {
    if (r < 1) return;
    var tmp = new Float32Array(a.length), win = 2 * r + 1;
    var x, y;
    for (y = 0; y < h; y++) {
      var row = y * w, acc = 0;
      for (x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
      for (x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        acc -= a[row + Math.min(w - 1, Math.max(0, x - r))];
        acc += a[row + Math.min(w - 1, Math.max(0, x + r + 1))];
      }
    }
    for (x = 0; x < w; x++) {
      var acc2 = 0;
      for (y = -r; y <= r; y++) acc2 += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (y = 0; y < h; y++) {
        a[y * w + x] = acc2 / win;
        acc2 -= tmp[Math.min(h - 1, Math.max(0, y - r)) * w + x];
        acc2 += tmp[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
      }
    }
  }

  /* プレビュー用の縮小 (面積平均) */
  function downscale(rgba, w, h, maxDim) {
    var sc = Math.min(1, maxDim / Math.max(w, h));
    if (sc >= 1) return { data: rgba, width: w, height: h };
    var nw = Math.max(1, Math.round(w * sc)), nh = Math.max(1, Math.round(h * sc));
    var out = new Uint8ClampedArray(nw * nh * 4);
    for (var y = 0; y < nh; y++) {
      var sy0 = Math.floor(y * h / nh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / nh));
      for (var x = 0; x < nw; x++) {
        var sx0 = Math.floor(x * w / nw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / nw));
        var r = 0, g = 0, b = 0, cnt = 0;
        for (var yy = sy0; yy < sy1; yy++) {
          for (var xx = sx0; xx < sx1; xx++) {
            var q = (yy * w + xx) * 4;
            r += rgba[q]; g += rgba[q + 1]; b += rgba[q + 2]; cnt++;
          }
        }
        var o = (y * nw + x) * 4;
        out[o] = r / cnt; out[o + 1] = g / cnt; out[o + 2] = b / cnt; out[o + 3] = 255;
      }
    }
    return { data: out, width: nw, height: nh };
  }

  return { analyze: analyze, apply: apply, develop: develop, downscale: downscale, DEFAULTS: DEFAULTS };
});
