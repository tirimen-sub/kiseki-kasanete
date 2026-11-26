// ==========================================
// 4. データ読み込みと軌跡生成
// ==========================================
// data/trajectory.bin.gz は tools/build-data.mjs で CSV から生成した前処理済みデータ。
// CSV のパース・累積距離・県判定はビルド時に済んでいるので、ここでは
// 「展開 → 型付き配列に復元 → 軌跡ジオメトリを組み立てる」だけを行う。
let trajectoryLines = [];
let totalVertices = 0;
// 全点の時刻 (昇順) と累積距離 (km)。距離表示の二分探索に使う
let trajectoryTimes = null;
let trajectoryCumulativeKm = null;
// 県ラベル → 最初に訪れた時刻 (ms)
let prefectureFirstVisit = null;

window.syncTrajectoryGlowVisibility = (mode = window.appThemeMode || 'dark') => {
    const isLight = mode === 'light';
    trajectoryLines.forEach(line => {
        if (line.glowLine) {
            line.glowLine.visible = !isLight;
        }
    });
};

const loadingOverlay = document.getElementById('loading-overlay');
const loadingMessage = document.getElementById('loading-message');
const loadingDetail = document.getElementById('loading-detail');
const loadingProgressBar = document.getElementById('progress-bar');
const loadingPercent = document.getElementById('loading-percent');

const TRAJECTORY_DATA_URL = 'data/trajectory.bin.gz';
const MIN_LOADER_VISIBLE_MS = 1600;
const loaderStartedAt = performance.now();

// 旧バージョンが IndexedDB に保存していた巨大なキャッシュ (数十 MB) を片付ける
try {
    if (window.indexedDB) indexedDB.deleteDatabase('journey-with-log-cache');
} catch (error) {
    // 削除できなくても表示には影響しない
}

function createHeatmapTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 68, 0, 1)');
    grad.addColorStop(0.2, 'rgba(255, 68, 0, 0.8)');
    grad.addColorStop(0.5, 'rgba(255, 0, 0, 0.3)');
    grad.addColorStop(1, 'rgba(255, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
}

function setLoadingStatus(percent, message, detail) {
    const clampedPercent = Math.max(0, Math.min(100, percent));
    if (loadingMessage && message) loadingMessage.textContent = message;
    if (loadingDetail && detail !== undefined) loadingDetail.textContent = detail;
    if (loadingProgressBar) loadingProgressBar.style.width = `${clampedPercent.toFixed(1)}%`;
    if (loadingPercent) loadingPercent.textContent = `${Math.round(clampedPercent)}%`;
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

// ---------- 読み込み ----------
async function fetchWithProgress(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const total = Number(response.headers.get('Content-Length')) || 0;
    if (!response.body || !total) return new Uint8Array(await response.arrayBuffer());

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(Math.min(1, received / total));
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}

async function gunzipIfNeeded(bytes) {
    // サーバーが Content-Encoding で既に展開済みの場合はそのまま使う
    const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!isGzip) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('このブラウザは DecompressionStream に対応していません');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
}

// tools/build-data.mjs の出力形式を復元する
function decodeTrajectoryBuffer(buffer) {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'KSKT') throw new Error('trajectory データの形式が不正です');
    const headerLength = view.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)));
    if (header.version !== 2) throw new Error(`未対応の trajectory データ (version ${header.version})`);

    const n = header.count;
    let offset = 8 + headerLength;
    const columns = {};
    header.columns.forEach(name => {
        const deltas = new Int32Array(buffer, offset, n);
        offset += n * 4;
        const scale = header.scale[name];
        const out = (name === 'alt' || name === 'dist') ? new Float32Array(n) : new Float64Array(n);
        let acc = header.base[name];
        for (let i = 0; i < n; i++) {
            acc += deltas[i];
            out[i] = acc / scale;
        }
        columns[name] = out;
    });

    return {
        count: n,
        time: columns.time,
        lat: columns.lat,
        lon: columns.lon,
        alt: columns.alt,
        distKm: columns.dist, // scale.dist = 1000 なので復元値は km
        prefectureFirstVisit: header.prefectureFirstVisit || {},
        // 出発点のインデックス → 到着点のインデックス
        flightArrivalByDeparture: new Map((header.flights || []).map(([dep, arr]) => [dep, arr])),
    };
}

// ---------- 再生中に main.js から呼ばれるヘルパー ----------
function getCumulativeDistanceAt(time) {
    if (!trajectoryTimes || trajectoryTimes.length === 0) return 0;
    let low = 0;
    let high = trajectoryTimes.length - 1;
    let result = 0;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (trajectoryTimes[mid] <= time) {
            result = trajectoryCumulativeKm[mid];
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return result;
}

// ---------- 軌跡ジオメトリ ----------
function splitIntoSegments(data) {
    // 12 時間以上の空白、または時代 (高校/大学1年/大学2年) の切り替わりで分割
    const segments = [];
    const GAP_MS = 12 * 60 * 60 * 1000;
    let start = 0;
    for (let i = 1; i <= data.count; i++) {
        const isBreak = i === data.count
            || data.time[i] - data.time[i - 1] > GAP_MS
            || getEraCode(data.time[i]) !== getEraCode(data.time[i - 1]);
        if (isBreak) {
            if (i - start >= 2) segments.push({ start, end: i });
            start = i;
        }
    }
    return segments;
}

// 区間内で実際に頂点にする点の並びを決める。
// 飛行区間 (ビルド時に検出) は出発点と到着点だけを残して 1 本の放物線にする。
// 記録が途切れて 150km 以上飛んだ移動も放物線で結ぶ。
const FLIGHT_THRESHOLD_KM = 150;

function planSegmentPath(data, segment) {
    const { start, end } = segment;
    const nodes = [{ index: start, arcKm: 0 }];
    let k = start;
    while (k < end - 1) {
        const arrival = data.flightArrivalByDeparture.get(k);
        const next = (arrival !== undefined && arrival < end) ? arrival : k + 1;
        const dist = haversineDistance(data.lat[k], data.lon[k], data.lat[next], data.lon[next]);
        const isArc = next !== k + 1 || dist > FLIGHT_THRESHOLD_KM;
        nodes.push({ index: next, arcKm: isArc ? dist : 0 });
        k = next;
    }
    return nodes;
}

const arcStepsFor = (km) => Math.min(40, Math.max(10, Math.floor(km * 0.25)));

function buildSegmentGeometry(data, segment) {
    const { CENTER_LON, CENTER_LAT, SCALE, BASE_HEIGHT, ALT_SCALE } = window;
    const nodes = planSegmentPath(data, segment);

    let vertexCount = 0;
    nodes.forEach(node => { vertexCount += node.arcKm > 0 ? arcStepsFor(node.arcKm) : 1; });

    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const times = new Float64Array(vertexCount);
    let v = 0;
    const pushVertex = (x, y, z, t) => {
        const c = getColorByTime(t);
        positions[v * 3] = x;
        positions[v * 3 + 1] = y;
        positions[v * 3 + 2] = z;
        colors[v * 3] = c.r;
        colors[v * 3 + 1] = c.g;
        colors[v * 3 + 2] = c.b;
        times[v] = t;
        v++;
    };

    let prevX = 0, prevY = 0, prevZ = 0, prevT = 0;
    nodes.forEach(({ index: k, arcKm }) => {
        const x = (data.lon[k] - CENTER_LON) * SCALE;
        const y = BASE_HEIGHT + (data.alt[k] * ALT_SCALE); // 表示用高度 (ビルド時に平滑化済み)
        const z = -(data.lat[k] - CENTER_LAT) * SCALE;
        const t = data.time[k];

        if (arcKm > 0) {
            const steps = arcStepsFor(arcKm);
            const arcHeight = Math.max(prevY, y) + (arcKm * 0.005);
            const midX = (prevX + x) / 2;
            const midZ = (prevZ + z) / 2;
            for (let j = 1; j <= steps; j++) {
                const s = j / steps;
                const w0 = (1 - s) ** 2;
                const w1 = 2 * (1 - s) * s;
                const w2 = s ** 2;
                pushVertex(
                    w0 * prevX + w1 * midX + w2 * x,
                    w0 * prevY + w1 * arcHeight + w2 * y,
                    w0 * prevZ + w1 * midZ + w2 * z,
                    prevT + (t - prevT) * s
                );
            }
        } else {
            pushVertex(x, y, z, t);
        }
        prevX = x; prevY = y; prevZ = z; prevT = t;
    });

    return { positions, colors, times, vertexCount };
}

function buildHeatmap(data) {
    const positions = new Float32Array(data.count * 3);
    const y = window.BASE_HEIGHT + 0.01;
    for (let i = 0; i < data.count; i++) {
        positions[i * 3] = (data.lon[i] - window.CENTER_LON) * window.SCALE;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = -(data.lat[i] - window.CENTER_LAT) * window.SCALE;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
        size: 0.8,
        map: createHeatmapTexture(),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.7,
        color: 0xffffff
    });
    window.heatmapGroup.add(new THREE.Points(geometry, material));
}

async function buildTrajectoryScene(data) {
    trajectoryTimes = data.time;
    trajectoryCumulativeKm = data.distKm;
    prefectureFirstVisit = data.prefectureFirstVisit;
    if (latestPlaybackTime != null) syncPrefectureRevealToTime(latestPlaybackTime);

    document.getElementById('ui-total-dist').innerHTML = `0 <span style="font-size: 12px; color: #aaaaaa;">km</span>`;
    buildHeatmap(data);

    const segments = splitIntoSegments(data);
    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2, transparent: true, opacity: 0.9 });
    const glowMaterial = new THREE.LineBasicMaterial({ color: 0xff2f55, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false });

    let lastYield = performance.now();
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex];
        const { positions, colors, times, vertexCount } = buildSegmentGeometry(data, segment);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setDrawRange(0, 0);
        const line = new THREE.Line(geometry, lineMat);

        const segEra = getEraCode(data.time[segment.start]);
        const isHighSchoolSegment = segEra === 'hs';
        const glowLine = isHighSchoolSegment ? new THREE.Line(geometry, glowMaterial) : null;
        if (glowLine) glowLine.visible = window.appThemeMode !== 'light';

        window.eraGroups[segEra].add(line);
        if (glowLine) window.eraGroups[segEra].add(glowLine);

        trajectoryLines.push({ geometry, count: vertexCount, startIndex: totalVertices, times, glowLine });
        totalVertices += vertexCount;

        // 長時間メインスレッドを塞がないよう、50ms ごとに描画へ処理を返す
        if (performance.now() - lastYield > 50) {
            setLoadingStatus(60 + 40 * ((segmentIndex + 1) / segments.length), `軌跡を準備中... (${segmentIndex + 1}/${segments.length})`, '');
            await nextFrame();
            lastYield = performance.now();
        }
    }

    if (typeof window.syncTrajectoryGlowVisibility === 'function') {
        window.syncTrajectoryGlowVisibility(window.appThemeMode);
    }
    const seekBar = document.getElementById('seek-bar');
    if (seekBar) seekBar.max = totalVertices;
    setLoadingStatus(100, '準備完了', '');
}

function hideLoadingOverlay() {
    if (!loadingOverlay) return;
    const elapsed = performance.now() - loaderStartedAt;
    const remaining = Math.max(0, MIN_LOADER_VISIBLE_MS - elapsed);
    setTimeout(() => loadingOverlay.classList.add('hidden'), remaining);
}

async function bootTrajectoryData() {
    setLoadingStatus(1, '移動ログを読み込み中...', '');
    try {
        const bytes = await fetchWithProgress(TRAJECTORY_DATA_URL, (ratio) => {
            setLoadingStatus(1 + ratio * 49, '移動ログを読み込み中...', '');
        });
        setLoadingStatus(50, 'データを展開中...', '');
        await nextFrame();
        const data = decodeTrajectoryBuffer(await gunzipIfNeeded(bytes));
        setLoadingStatus(60, '軌跡を準備中...', '');
        await nextFrame();
        await buildTrajectoryScene(data);
        hideLoadingOverlay();
    } catch (error) {
        console.error('Trajectory load failed', error);
        setLoadingStatus(100, '読み込みに失敗しました', String(error && error.message || error));
    }
}

bootTrajectoryData();
