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
// 出力:
//   data/trajectory.bin.gz      … 時刻・緯度・経度・高度・累積距離を詰めたバイナリ (gzip)
//
// これまでブラウザ側で毎回やっていた
//   CSV のパース / ソート / 累積距離の計算 / 37 万点 × 47 県の県判定
// をここで一度だけ済ませておく。
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
const GEOJSON_PATH = path.join(ROOT, 'data/japan-prefectures.json');
const OUT_PATH = path.join(ROOT, 'data/trajectory.bin.gz');

const FORMAT_VERSION = 1;
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
    const points = loadPoints(CSV_PATHS);
    if (points.length === 0) throw new Error('有効な位置データがありません');
    console.log(`points: ${points.length}`);

    const cumulative = computeCumulativeDistances(points);
    const geojson = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf8'));
    const prefectureFirstVisit = computePrefectureFirstVisits(points, buildPrefectureIndex(geojson));
    console.log(`prefectures visited: ${Object.keys(prefectureFirstVisit).length}`);
    console.log(`total distance: ${cumulative[cumulative.length - 1].toFixed(1)} km`);

    const n = points.length;
    const q = (arr, scale) => arr.map(v => Math.round(v * scale));
    const times = points.map(p => p.time);
    const lats = q(points.map(p => p.lat), LATLON_SCALE);
    const lons = q(points.map(p => p.lon), LATLON_SCALE);
    const alts = q(points.map(p => p.alt), ALT_SCALE);
    const dists = q(Array.from(cumulative), DIST_SCALE);

    const header = {
        version: FORMAT_VERSION,
        count: n,
        base: { time: times[0], lat: lats[0], lon: lons[0], alt: 0, dist: 0 },
        scale: { time: 1, lat: LATLON_SCALE, lon: LATLON_SCALE, alt: ALT_SCALE, dist: DIST_SCALE },
        columns: ['time', 'lat', 'lon', 'alt', 'dist'],
        prefectureFirstVisit,
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
