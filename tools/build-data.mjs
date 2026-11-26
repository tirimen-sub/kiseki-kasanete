#!/usr/bin/env node
// ==========================================
// 移動ログ CSV と県境 GeoJSON を、ブラウザがすぐ使える形に前処理するスクリプト
//
//   node tools/build-data.mjs                 … ルートの *_aslog.csv をすべて読み込む
//   node tools/build-data.mjs a.csv b.csv     … ファイルを指定する
//
// 入力:
//   *_aslog.csv                 … 位置ログ (期間ごとに分かれていてよい。重複行は自動で除く)
//   data/japan-prefectures.json … 県境 (座標を丸めて軽量化したもの)
//   data/philippines.json       … フィリピンの国境 (Natural Earth)
// 出力:
//   data/trajectory.bin.gz      … 時刻・緯度・経度・表示用高度・累積距離・飛行区間を詰めたバイナリ (gzip)
//
// やっていること:
//   CSV のパース / ソート / GPS の飛び値除去 / 累積距離 / 県 (国) 判定 /
//   飛行区間の検出 / 表示用高度の平滑化
// ==========================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV_PATHS = (process.argv.length > 2
    ? process.argv.slice(2)
    : fs.readdirSync(ROOT).filter(name => name.endsWith('_aslog.csv')).sort()
).map(name => path.resolve(ROOT, name));
const REGION_GEOJSON_PATHS = ['data/japan-prefectures.json', 'data/philippines.json'].map(p => path.join(ROOT, p));
const OUT_PATH = path.join(ROOT, 'data/trajectory.bin.gz');

const FORMAT_VERSION = 2;
const LATLON_SCALE = 1e6; // 1e-6 度 (≒ 0.1m) 単位で量子化
const ALT_SCALE = 10;     // 0.1m 単位で量子化
const DIST_SCALE = 1000;  // 累積距離は m 単位で保持

// ---------- CSV ----------
// 列: 状態, 緯度, 経度, 時刻, 精度, 高度, メモ  (すべてダブルクォート囲み)
function parseCsvLine(line) {
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else inQuotes = false;
            } else cur += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ',') { cells.push(cur); cur = ''; }
        else cur += ch;
    }
    cells.push(cur);
    return cells;
}

function loadPointsFromFile(csvPath, points, seen) {
    const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/);
    const header = parseCsvLine(lines[0].replace(/^﻿/, ''));
    const col = (name) => {
        const idx = header.indexOf(name);
        if (idx < 0) throw new Error(`CSV に列 "${name}" がありません`);
        return idx;
    };
    const iLat = col('緯度:latitude');
    const iLon = col('経度:longitude');
    const iTime = col('時刻:date');
    const iAcc = col('精度:accuracy');
    const iAlt = col('高度:altitude');

    let added = 0;
    const fileKeys = [];
    for (let li = 1; li < lines.length; li++) {
        if (!lines[li]) continue;
        const c = parseCsvLine(lines[li]);
        // 元の trajectory-loader.js と同じ条件でフィルタ
        if (!c[iLat] || !c[iLon] || !c[iTime]) continue;
        const p = {
            lat: parseFloat(c[iLat]),
            lon: parseFloat(c[iLon]),
            alt: Math.max(0, parseFloat(c[iAlt]) || 0),
            acc: parseFloat(c[iAcc]) || 100,
            time: new Date(c[iTime]).getTime(),
        };
        if (isNaN(p.time) || isNaN(p.lat) || isNaN(p.lon)) continue;
        // 期間が重なったエクスポートを複数読んでも二重にならないよう、
        // 先に読んだファイルにある行は飛ばす (同じファイル内の行はそのまま残す)
        const key = `${p.time},${p.lat},${p.lon}`;
        if (seen.has(key)) continue;
        fileKeys.push(key);
        points.push(p);
        added++;
    }
    fileKeys.forEach(key => seen.add(key));
    console.log(`${path.basename(csvPath)}: ${added} points`);
}

function loadPoints(csvPaths) {
    if (csvPaths.length === 0) throw new Error('CSV が見つかりません (*_aslog.csv)');
    const points = [];
    const seen = new Set();
    csvPaths.forEach(csvPath => loadPointsFromFile(csvPath, points, seen));
    points.sort((a, b) => a.time - b.time); // 安定ソート (ブラウザ版と同じ順序)
    return points;
}

// ---------- 距離 ----------
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// 元実装と同じ「精度 30m 以内・10m〜1000km の移動のみ加算」ロジック
function computeCumulativeDistances(points) {
    const out = new Float64Array(points.length);
    let total = 0;
    let last = null;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.acc <= 30) {
            if (last) {
                const d = haversineDistance(last.lat, last.lon, p.lat, p.lon);
                if (d > 0.01 && d < 1000) { total += d; last = p; }
            } else last = p;
        }
        out[i] = total;
    }
    return out;
}

// ---------- 県判定 ----------
// main.js の extractPrefectureLabel と同じルール (ラベルを一致させるため)
function extractPrefectureLabel(properties = {}) {
    const preferredKeys = ['name', 'prefecture', 'prefecture_name', 'name_jp', 'jp_name', 'title', 'label', 'nam', 'N03_001', 'PREF_NAME', 'pref_name', 'name_ja'];
    for (const key of preferredKeys) {
        const value = properties[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const stringValues = Object.values(properties).filter(v => typeof v === 'string' && v.trim());
    return stringValues.find(v => /[都道府県]/.test(v)) || stringValues[0] || '';
}

function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
}

function buildPrefectureIndex(geojson) {
    // バウンディングボックスで先に絞り込んでから point-in-polygon する
    const regions = [];
    for (const feature of geojson.features) {
        if (!feature.geometry) continue;
        const name = extractPrefectureLabel(feature.properties || {});
        if (!name) continue;
        const polys = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
        const polygons = polys.filter(p => p[0]).map(rings => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const [x, y] of rings[0]) {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
            return { rings, minX, minY, maxX, maxY };
        });
        regions.push({ name, polygons });
    }
    return (lon, lat) => {
        for (const region of regions) {
            for (const poly of region.polygons) {
                if (lon < poly.minX || lon > poly.maxX || lat < poly.minY || lat > poly.maxY) continue;
                if (!pointInRing(lon, lat, poly.rings[0])) continue;
                let inHole = false;
                for (let h = 1; h < poly.rings.length; h++) {
                    if (pointInRing(lon, lat, poly.rings[h])) { inHole = true; break; }
                }
                if (!inHole) return region.name;
            }
        }
        return null;
    };
}

// 各県に「最初に足を踏み入れた時刻」を記録する。
// 再生中の県塗りつぶしは「その時刻 <= 再生時刻」で判定できるので、
// 37 万点分の県名配列をブラウザに持たせる必要がなくなる。
function computePrefectureFirstVisits(points, findPrefecture) {
    const firstVisit = {};
    const cache = new Map(); // 同じ地点 (約 10m グリッド) の判定結果を使い回す
    for (const p of points) {
        if (p.alt > 50) continue; // 元実装同様、上空 (飛行機など) は県判定しない
        const key = `${Math.round(p.lon * 1e4)},${Math.round(p.lat * 1e4)}`;
        let name = cache.get(key);
        if (name === undefined) {
            name = findPrefecture(p.lon, p.lat);
            cache.set(key, name);
        }
        if (name && firstVisit[name] === undefined) firstVisit[name] = p.time;
    }
    return firstVisit;
}

// ---------- GPS の飛び値除去 ----------
// 一瞬だけ数百 km 先に飛んで戻ってくる点 (古い位置のまま記録された点や精度の悪い点) を除く。
// 「近くに固まった点の並び B」の前後 A → B → C を見て、
//   ・A→B と B→C がどちらも飛行機でもあり得ない速さ、または
//   ・B だけが大きく離れていて A と C は近い
// なら B を飛び値とみなす。
const SPIKE_MIN_KM = 50;
const IMPOSSIBLE_KMH = 1500;
const CLUSTER_KM = 2;
const CLUSTER_MAX_POINTS = 2000;

function hopSpeedKmh(a, b) {
    const hours = Math.max((b.time - a.time) / 3.6e6, 1 / 3600);
    return haversineDistance(a.lat, a.lon, b.lat, b.lon) / hours;
}

function removeGpsSpikes(points) {
    const keep = new Uint8Array(points.length).fill(1);
    let removed = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const a = points[i - 1];
        const b = points[i];
        if (haversineDistance(a.lat, a.lon, b.lat, b.lon) < SPIKE_MIN_KM) continue;
        // b から始まる「近くに固まった点の並び」の終わりを探す
        let j = i;
        while (j + 1 < points.length && j - i < CLUSTER_MAX_POINTS
            && haversineDistance(b.lat, b.lon, points[j + 1].lat, points[j + 1].lon) < CLUSTER_KM) j++;
        if (j + 1 >= points.length) break;
        const last = points[j];
        const c = points[j + 1];
        const dIn = haversineDistance(a.lat, a.lon, b.lat, b.lon);
        const dOut = haversineDistance(last.lat, last.lon, c.lat, c.lon);
        if (dOut < SPIKE_MIN_KM) continue;
        const bothImpossible = hopSpeedKmh(a, b) > IMPOSSIBLE_KMH && hopSpeedKmh(last, c) > IMPOSSIBLE_KMH;
        const returnsBack = haversineDistance(a.lat, a.lon, c.lat, c.lon) < 0.5 * Math.min(dIn, dOut);
        if (bothImpossible || returnsBack) {
            for (let k = i; k <= j; k++) keep[k] = 0;
            removed += j - i + 1;
            i = j;
        }
    }
    return { points: points.filter((_, i) => keep[i]), removed };
}

// ---------- 飛行区間の検出 ----------
// 上空 (3000m 超) の点を核にして、
// 前後に地上 (300m 以下かつ低速) の点が出てくるところまで広げたものを 1 回のフライトとする。
// 出発地と到着地が 100km 以上離れているものだけを採用する。
// (速さだけで判定すると、新幹線の GPS の瞬間的なズレを飛行機と誤認するので使わない)
const FLIGHT_CORE_ALT = 3000;
const GROUND_ALT = 300;
const GROUND_KMH = 150;
const FLIGHT_MERGE_MS = 40 * 60 * 1000;
const FLIGHT_EXPAND_MS = 60 * 60 * 1000;
const FLIGHT_MIN_KM = 100;

function detectFlights(points) {
    const n = points.length;
    const isCore = (i) => points[i].alt > FLIGHT_CORE_ALT;
    // 上空にいる、または直前の点から速く移動してきた (記録が途切れたまま遠くへ移動した場合も含む)
    const isAirborne = (i) => {
        if (i <= 0 || i >= n) return false;
        const p = points[i];
        if (p.alt > GROUND_ALT) return true;
        const q = points[i - 1];
        const dist = haversineDistance(q.lat, q.lon, p.lat, p.lon);
        return hopSpeedKmh(q, p) > GROUND_KMH && (p.time - q.time < 5 * 60 * 1000 || dist > 50);
    };
    // 機内で一瞬だけ混ざる古い位置 (高度 0m) などに引っかからないよう、2 点先まで見て判定する
    const airborneNear = (i, dir) => isAirborne(i) || isAirborne(i + dir) || isAirborne(i + 2 * dir);

    // 核となる点を時間的に近いものどうしでまとめる
    const runs = [];
    for (let i = 0; i < n; i++) {
        if (!isCore(i)) continue;
        const last = runs[runs.length - 1];
        if (last && points[i].time - points[last.end].time < FLIGHT_MERGE_MS) last.end = i;
        else runs.push({ start: i, end: i });
    }

    const flights = [];
    for (const run of runs) {
        let dep = run.start;
        while (dep > 0 && points[run.start].time - points[dep].time < FLIGHT_EXPAND_MS && airborneNear(dep, -1)) dep--;
        let arr = run.end;
        while (arr < n - 1 && points[arr].time - points[run.end].time < FLIGHT_EXPAND_MS && airborneNear(arr, 1)) arr++;
        const prev = flights[flights.length - 1];
        if (prev && dep <= prev[1]) { prev[1] = Math.max(prev[1], arr); continue; }
        flights.push([dep, arr]);
    }
    return flights.filter(([dep, arr]) =>
        haversineDistance(points[dep].lat, points[dep].lon, points[arr].lat, points[arr].lon) >= FLIGHT_MIN_KM);
}

// ---------- 表示用の高度 ----------
// 地上の移動だけを対象に、中央値 (単発の高度の飛び値を消す) → 移動平均でならす。
// 飛行区間の途中の点はブラウザ側で放物線に置き換えるので、平滑化の計算から外す。
const SMOOTH_WINDOW = 2;
const MAX_GROUND_ALT = 4000;

function computeDisplayAltitudes(points, flights) {
    const n = points.length;
    const interior = new Uint8Array(n);
    for (const [dep, arr] of flights) for (let k = dep + 1; k < arr; k++) interior[k] = 1;

    const windowValues = (src, i) => {
        const values = [];
        for (let j = Math.max(0, i - SMOOTH_WINDOW); j <= Math.min(n - 1, i + SMOOTH_WINDOW); j++) {
            if (!interior[j]) values.push(src[j]);
        }
        return values;
    };
    const raw = points.map(p => Math.min(p.alt, MAX_GROUND_ALT));
    const median = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        if (interior[i]) continue;
        const v = windowValues(raw, i).sort((a, b) => a - b);
        median[i] = v[v.length >> 1];
    }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        if (interior[i]) continue;
        const v = windowValues(median, i);
        out[i] = v.reduce((sum, x) => sum + x, 0) / v.length;
    }
    return out;
}

// ---------- エンコード ----------
// 各列を整数に量子化 → 差分符号化 → Int32 で列ごとに並べる。
// 差分は小さい値ばかりになるので gzip がよく効く。
function deltaEncode(values, base) {
    const out = new Int32Array(values.length);
    let prev = base;
    for (let i = 0; i < values.length; i++) {
        const d = values[i] - prev;
        if (d > 0x7fffffff || d < -0x80000000) throw new Error(`差分が Int32 に収まりません (index ${i}, delta ${d})`);
        out[i] = d;
        prev = values[i];
    }
    return out;
}

function main() {
    const t0 = Date.now();
    const loaded = loadPoints(CSV_PATHS);
    if (loaded.length === 0) throw new Error('有効な位置データがありません');
    const { points, removed } = removeGpsSpikes(loaded);
    console.log(`points: ${points.length} (GPS の飛び値 ${removed} 点を除去)`);

    const cumulative = computeCumulativeDistances(points);
    const geojson = {
        features: REGION_GEOJSON_PATHS.flatMap(file => JSON.parse(fs.readFileSync(file, 'utf8')).features),
    };
    const prefectureFirstVisit = computePrefectureFirstVisits(points, buildPrefectureIndex(geojson));
    const flights = detectFlights(points);
    const displayAlt = computeDisplayAltitudes(points, flights);
    flights.forEach(([dep, arr]) => {
        const a = points[dep], b = points[arr];
        console.log(`  flight ${new Date(a.time).toISOString().slice(0, 16)}Z  ${a.lat.toFixed(2)},${a.lon.toFixed(2)} -> ${b.lat.toFixed(2)},${b.lon.toFixed(2)}  ${haversineDistance(a.lat, a.lon, b.lat, b.lon).toFixed(0)}km`);
    });
    console.log(`flights: ${flights.length}`);
    console.log(`prefectures visited: ${Object.keys(prefectureFirstVisit).length}`);
    console.log(`total distance: ${cumulative[cumulative.length - 1].toFixed(1)} km`);

    const n = points.length;
    const q = (arr, scale) => arr.map(v => Math.round(v * scale));
    const times = points.map(p => p.time);
    const lats = q(points.map(p => p.lat), LATLON_SCALE);
    const lons = q(points.map(p => p.lon), LATLON_SCALE);
    const alts = q(Array.from(displayAlt), ALT_SCALE);
    const dists = q(Array.from(cumulative), DIST_SCALE);

    const header = {
        version: FORMAT_VERSION,
        count: n,
        base: { time: times[0], lat: lats[0], lon: lons[0], alt: 0, dist: 0 },
        scale: { time: 1, lat: LATLON_SCALE, lon: LATLON_SCALE, alt: ALT_SCALE, dist: DIST_SCALE },
        columns: ['time', 'lat', 'lon', 'alt', 'dist'],
        prefectureFirstVisit,
        flights,
    };
    const columns = {
        time: deltaEncode(times, header.base.time),
        lat: deltaEncode(lats, header.base.lat),
        lon: deltaEncode(lons, header.base.lon),
        alt: deltaEncode(alts, header.base.alt),
        dist: deltaEncode(dists, header.base.dist),
    };

    // レイアウト: "KSKT" | uint32 ヘッダ長 | ヘッダ JSON (4 バイト境界までパディング) | 列データ (Int32 LE)
    let headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const pad = (4 - ((8 + headerBytes.length) % 4)) % 4;
    headerBytes = Buffer.concat([headerBytes, Buffer.alloc(pad, 0x20)]);
    const prefix = Buffer.alloc(8);
    prefix.write('KSKT', 0, 'ascii');
    prefix.writeUInt32LE(headerBytes.length, 4);
    const body = header.columns.map(name => Buffer.from(columns[name].buffer));
    const raw = Buffer.concat([prefix, headerBytes, ...body]);
    const gz = zlib.gzipSync(raw, { level: 9 });

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, gz);
    console.log(`wrote ${path.relative(ROOT, OUT_PATH)}: ${(gz.length / 1024 / 1024).toFixed(2)} MB (raw ${(raw.length / 1024 / 1024).toFixed(2)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
