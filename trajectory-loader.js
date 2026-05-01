// ==========================================
// 4. データ読み込みと軌跡生成
// ==========================================
let trajectoryLines = [];
let totalVertices = 0;
let cachedValidData = [];
let prefectureTrailPoints = [];
let prefectureTrailPointsReady = false;
let cumulativeDistances = [];

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

const TRAJECTORY_CACHE_DB = 'journey-with-log-cache';
const TRAJECTORY_CACHE_STORE = 'trajectory';
const TRAJECTORY_CACHE_KEY = 'v6';
const MIN_LOADER_VISIBLE_MS = 1600;
const loaderStartedAt = performance.now();

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

function openTrajectoryCacheDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(TRAJECTORY_CACHE_DB, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(TRAJECTORY_CACHE_STORE)) {
                db.createObjectStore(TRAJECTORY_CACHE_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function readTrajectoryCache() {
    try {
        const db = await openTrajectoryCacheDB();
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(TRAJECTORY_CACHE_STORE, 'readonly');
            const store = transaction.objectStore(TRAJECTORY_CACHE_STORE);
            const request = store.get(TRAJECTORY_CACHE_KEY);
            request.onsuccess = () => {
                const parsed = request.result;
                if (!parsed || parsed.version !== 6 || !Array.isArray(parsed.validData)) {
                    resolve(null);
                    return;
                }
                resolve(parsed);
            };
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        return null;
    }
}

async function writeTrajectoryCache(payload) {
    try {
        const db = await openTrajectoryCacheDB();
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(TRAJECTORY_CACHE_STORE, 'readwrite');
            const store = transaction.objectStore(TRAJECTORY_CACHE_STORE);
            const request = store.put(payload, TRAJECTORY_CACHE_KEY);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.warn('Trajectory cache write failed', error);
    }
}

function setLoadingStatus(percent, message, detail) {
    const clampedPercent = Math.max(0, Math.min(100, percent));
    if (loadingMessage && message) loadingMessage.textContent = message;
    if (loadingDetail && detail !== undefined) loadingDetail.textContent = detail;
    if (loadingProgressBar) loadingProgressBar.style.width = `${clampedPercent.toFixed(1)}%`;
    if (loadingPercent) loadingPercent.textContent = `${Math.round(clampedPercent)}%`;
}

async function processTrajectoryData(rawData, options = {}) {
    const fromCache = options.fromCache === true;
    setLoadingStatus(
        fromCache ? 18 : 8,
        fromCache ? 'キャッシュから復元中...' : 'データを整理中...',
        fromCache ? '前回の処理結果を使って、CSV の再解析を省いています。' : 'CSV の中身を読み取って、表示用の形に整えています。'
    );

    const validData = Array.isArray(rawData) && rawData.length > 0 && typeof rawData[0].lat === 'number' && typeof rawData[0].lon === 'number'
        ? rawData.map(point => ({ ...point }))
        : rawData
            .filter(d => d['緯度:latitude'] && d['経度:longitude'] && d['時刻:date'])
            .map(d => ({
                lat: parseFloat(d['緯度:latitude']),
                lon: parseFloat(d['経度:longitude']),
                alt: Math.max(0, parseFloat(d['高度:altitude']) || 0),
                acc: parseFloat(d['精度:accuracy']) || 100,
                time: new Date(d['時刻:date']).getTime()
            }))
            .filter(d => !isNaN(d.time) && !isNaN(d.lat) && !isNaN(d.lon));

    validData.sort((a, b) => a.time - b.time);
    cachedValidData = validData;
    setLoadingStatus(
        fromCache ? 24 : 14,
        fromCache ? 'キャッシュ済みの位置情報を読み込み中...' : '位置情報を解析中...',
        fromCache ? '県判定済みの軌跡を復元しています。' : '緯度・経度・時刻を正規化しています。'
    );

    const isHighAltitude = (point) => point.alt > 50;

    const populatePrefectureTrailPoints = () => {
        if (prefectureTrailPointsReady) return;
        if (prefectureRegionData.length === 0 || cachedValidData.length === 0) return;

        prefectureTrailPoints.length = 0;
        for (let i = 0; i < cachedValidData.length; i++) {
            const point = cachedValidData[i];
            const prefecture = !isHighAltitude(point) ? prefectureRegionData.find(region => geometryContainsPoint(region.geometry, point.lon, point.lat)) : null;
            point.prefecture = prefecture ? prefecture.name : '不明';
            prefectureTrailPoints.push(point);
        }

        prefectureTrailPointsReady = true;
        if (latestPlaybackTime != null) {
            syncPrefectureRevealToTime(latestPlaybackTime);
        }
    };

    if (options.cachedPrefectureTrailPoints && options.cachedPrefectureTrailPoints.length > 0) {
        prefectureTrailPoints.length = 0;
        options.cachedPrefectureTrailPoints.forEach(point => prefectureTrailPoints.push({ ...point }));
        prefectureTrailPointsReady = true;
        setLoadingStatus(34, '県名をキャッシュから復元中...', '前回の県判定結果を再利用しています。');
    } else {
        populatePrefectureTrailPoints();
        setLoadingStatus(24, '県名を割り当て中...', '県境ポリゴンとの照合を進めています。');
        prefectureDataPromise.then(populatePrefectureTrailPoints);
    }

    if (options.cachedCumulativeDistances && options.cachedCumulativeDistances.length > 0) {
        cumulativeDistances = options.cachedCumulativeDistances.map(item => ({ ...item }));
        setLoadingStatus(fromCache ? 42 : 34, fromCache ? '移動距離をキャッシュから復元中...' : '移動距離を計算中...', fromCache ? '前回の累積距離を使っています。' : '移動距離を一つずつ積み上げています。');
    } else {
        cumulativeDistances = [];
        let robustTotalDistance = 0;
        let lastValidPoint = null;

        validData.forEach(p => {
            if (p.acc <= 30) {
                if (lastValidPoint) {
                    const dist = haversineDistance(lastValidPoint.lat, lastValidPoint.lon, p.lat, p.lon);
                    if (dist > 0.01 && dist < 1000) {
                        robustTotalDistance += dist;
                        lastValidPoint = p;
                    }
                } else {
                    lastValidPoint = p;
                }
            }
            cumulativeDistances.push({ time: p.time, dist: robustTotalDistance });
        });
        setLoadingStatus(34, '移動距離を計算中...', '移動距離を一つずつ積み上げています。');
    }

    document.getElementById('ui-total-dist').innerHTML = `0 <span style="font-size: 12px; color: #aaaaaa;">km</span>`;

    const hmPositions = [];
    validData.forEach(p => {
        hmPositions.push((p.lon - window.CENTER_LON) * window.SCALE, window.BASE_HEIGHT + 0.01, -(p.lat - window.CENTER_LAT) * window.SCALE);
    });
    const hmGeometry = new THREE.BufferGeometry();
    hmGeometry.setAttribute('position', new THREE.Float32BufferAttribute(hmPositions, 3));
    const hmMat = new THREE.PointsMaterial({
        size: 0.8,
        map: createHeatmapTexture(),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.7,
        color: 0xffffff
    });
    window.heatmapGroup.add(new THREE.Points(hmGeometry, hmMat));

    const segments = [];
    let currentSegment = [];

    for (let i = 0; i < validData.length; i++) {
        const point = validData[i];
        if (currentSegment.length === 0) {
            currentSegment.push(point);
        } else {
            const prev = currentSegment[currentSegment.length - 1];
            const timeGap = point.time - prev.time;
            const prevEra = getEraCode(prev.time);
            const currEra = getEraCode(point.time);

            if (timeGap > 12 * 60 * 60 * 1000 || prevEra !== currEra) {
                if (currentSegment.length >= 2) segments.push(currentSegment);
                currentSegment = [point];
            } else {
                currentSegment.push(point);
            }
        }
    }
    if (currentSegment.length >= 2) segments.push(currentSegment);

    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2, transparent: true, opacity: 0.9 });
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    let totalLoadSteps = Math.max(segments.length, 1);
    let currentLoadStep = 0;

    const updateLoadProgress = (step, total = totalLoadSteps, message = '') => {
        currentLoadStep = step;
        const percent = Math.max(0, Math.min(100, Math.round((currentLoadStep / total) * 100)));
        const progressBar = document.getElementById('progress-bar');
        const percentDisplay = document.getElementById('loading-percent');
        if (loadingMessage && message) loadingMessage.textContent = message;
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (percentDisplay) percentDisplay.textContent = `${percent}%`;
    };

    updateLoadProgress(0, totalLoadSteps, 'CSV を解析中...');

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex];
        const SMOOTH_WINDOW = 2;
        const smoothedSegment = segment.map((p, i) => {
            let sumAlt = 0;
            let count = 0;
            for (let j = Math.max(0, i - SMOOTH_WINDOW); j <= Math.min(segment.length - 1, i + SMOOTH_WINDOW); j++) {
                sumAlt += segment[j].alt;
                count++;
            }
            return { ...p, alt: sumAlt / count };
        });

        const vertices = [];
        const times = [];
        const colors = [];
        const FLIGHT_THRESHOLD = 150;

        for (let i = 0; i < smoothedSegment.length; i++) {
            const p = smoothedSegment[i];
            const x = (p.lon - window.CENTER_LON) * window.SCALE;
            const y = window.BASE_HEIGHT + (p.alt * window.ALT_SCALE);
            const z = -(p.lat - window.CENTER_LAT) * window.SCALE;

            if (i > 0) {
                const prevP = smoothedSegment[i - 1];
                const prevX = (prevP.lon - window.CENTER_LON) * window.SCALE;
                const prevY = window.BASE_HEIGHT + (prevP.alt * window.ALT_SCALE);
                const prevZ = -(prevP.lat - window.CENTER_LAT) * window.SCALE;
                const dist = haversineDistance(prevP.lat, prevP.lon, p.lat, p.lon);

                if (dist > FLIGHT_THRESHOLD) {
                    const arcSteps = Math.min(40, Math.max(10, Math.floor(dist * 0.25)));
                    for (let j = 1; j <= arcSteps; j++) {
                        const t = j / arcSteps;
                        const arcHeight = Math.max(prevY, y) + (dist * 0.005);
                        const curveX = (1 - t) ** 2 * prevX + 2 * (1 - t) * t * ((prevX + x) / 2) + t ** 2 * x;
                        const curveY = (1 - t) ** 2 * prevY + 2 * (1 - t) * t * arcHeight + t ** 2 * y;
                        const curveZ = (1 - t) ** 2 * prevZ + 2 * (1 - t) * t * ((prevZ + z) / 2) + t ** 2 * z;
                        const currentTime = prevP.time + (p.time - prevP.time) * t;
                        const c = getColorByTime(currentTime);

                        vertices.push(new THREE.Vector3(curveX, curveY, curveZ));
                        times.push(currentTime);
                        colors.push(c.r, c.g, c.b);
                    }
                } else {
                    const c = getColorByTime(p.time);
                    vertices.push(new THREE.Vector3(x, y, z));
                    times.push(p.time);
                    colors.push(c.r, c.g, c.b);
                }
            } else {
                const c = getColorByTime(p.time);
                vertices.push(new THREE.Vector3(x, y, z));
                times.push(p.time);
                colors.push(c.r, c.g, c.b);
            }
        }

        const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geometry.setDrawRange(0, 0);
        const line = new THREE.Line(geometry, lineMat);
        const segEra = getEraCode(segment[0].time);
        const isHighSchoolSegment = segEra === 'hs';
        const glowMaterial = isHighSchoolSegment
            ? new THREE.LineBasicMaterial({ color: 0xff2f55, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false })
            : null;
        const glowLine = isHighSchoolSegment ? new THREE.Line(geometry, glowMaterial) : null;
        if (glowLine) glowLine.visible = window.appThemeMode !== 'light';

        window.eraGroups[segEra].add(line);
        if (glowLine) window.eraGroups[segEra].add(glowLine);

        const lineStartIndex = totalVertices;
        trajectoryLines.push({ geometry, count: vertices.length, startIndex: lineStartIndex, times, glowLine });
        totalVertices += vertices.length;

        updateLoadProgress(
            ++currentLoadStep,
            totalLoadSteps,
            isHighSchoolSegment ? `高校の赤い発光を準備中... (${segmentIndex + 1}/${segments.length})` : `軌跡を準備中... (${segmentIndex + 1}/${segments.length})`
        );

        if (segmentIndex % 2 === 0) {
            await nextFrame();
        }
    }

    updateLoadProgress(totalLoadSteps);
    if (typeof window.syncTrajectoryGlowVisibility === 'function') {
        window.syncTrajectoryGlowVisibility(window.appThemeMode);
    }
    const seekBar = document.getElementById('seek-bar');
    if (seekBar) seekBar.max = totalVertices;

    await writeTrajectoryCache({
        version: 6,
        validData,
        prefectureTrailPoints: prefectureTrailPoints.map(point => ({ ...point })),
        cumulativeDistances: cumulativeDistances.map(item => ({ ...item })),
    });

    if (loadingOverlay) {
        const elapsed = performance.now() - loaderStartedAt;
        const remaining = Math.max(0, MIN_LOADER_VISIBLE_MS - elapsed);
        setTimeout(() => {
            loadingOverlay.classList.add('hidden');
        }, remaining);
    }
}

async function bootTrajectoryData() {
    setLoadingStatus(1, '展示を準備中...', '初回はデータを整形して保存しています。2回目以降はキャッシュから高速表示します。');
    const trajectoryCache = await readTrajectoryCache();

    if (trajectoryCache && Array.isArray(trajectoryCache.validData) && trajectoryCache.validData.length > 0) {
        setLoadingStatus(5, 'キャッシュを確認中...');
        await processTrajectoryData(trajectoryCache.validData, {
            fromCache: true,
            cachedPrefectureTrailPoints: trajectoryCache.prefectureTrailPoints || [],
            cachedCumulativeDistances: trajectoryCache.cumulativeDistances || [],
        });
        return;
    }

    setLoadingStatus(1, 'CSV を読み込み中...');
    try {
        const data = await d3.csv(CSV_FILE_URL);
        await processTrajectoryData(data, { fromCache: false });
    } catch (error) {
        console.error('CSV load failed', error);
        setLoadingStatus(100, '読み込みに失敗しました');
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

bootTrajectoryData();