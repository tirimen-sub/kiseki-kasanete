// ==========================================
// 1. 基本設定（シーン・カメラ・レンダラー）
// ==========================================
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.getElementById('canvas-container').appendChild(renderer.domElement);

scene.background = new THREE.Color(0x0a0a0a);
scene.fog = new THREE.Fog(0x0a0a0a, 500, 1000);

// ==========================================
// 1.5 Bloom Effect Setup (EffectComposer + UnrealBloomPass)
// ==========================================
const composer = new THREE.EffectComposer(renderer);
const renderPass = new THREE.RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.8, 0.4, 0.85);
bloomPass.threshold = 0.35;
bloomPass.strength = 1.1;
bloomPass.radius = 0.9;
composer.addPass(bloomPass);

const themeStorageKey = 'journey-theme-mode';
let appThemeMode = 'dark';

function applySceneTheme(mode, persist = true) {
    appThemeMode = mode === 'light' ? 'light' : 'dark';
    window.appThemeMode = appThemeMode;

    const isLight = appThemeMode === 'light';
    document.body.classList.toggle('theme-light', isLight);

    if (themeToggleButton) {
        themeToggleButton.classList.toggle('active', isLight);
        themeToggleButton.textContent = '☀';
        themeToggleButton.setAttribute('aria-label', isLight ? 'ダークモードに切り替え' : 'ライトモードに切り替え');
    }

    scene.background = new THREE.Color(isLight ? 0xf4f7fb : 0x0a0a0a);
    scene.fog = new THREE.Fog(isLight ? 0xeaf0f6 : 0x0a0a0a, 500, 1000);
    renderer.toneMappingExposure = isLight ? 0.92 : 1.0;
    bloomPass.enabled = !isLight;
    bloomPass.strength = isLight ? 0 : 0.7;

    if (typeof window.syncTrajectoryGlowVisibility === 'function') {
        window.syncTrajectoryGlowVisibility(appThemeMode);
    }

    if (persist) {
        try {
            localStorage.setItem(themeStorageKey, appThemeMode);
        } catch (error) {
            console.warn('Theme preference save failed', error);
        }
    }
}

window.appThemeMode = appThemeMode;
window.applySceneTheme = applySceneTheme;

const TOKYO_VIEW_TARGET = new THREE.Vector3(6.75, 0, 0.75);
const FOLLOW_CAMERA_UP = new THREE.Vector3(0, 0, -1);
const FREE_CAMERA_UP = new THREE.Vector3(0, 1, 0);

// Tokyo center coordinates: lon=139.7, lat=35.7
// Converted: x = (139.7 - 137.0) * 2.5 ≈ 6.75, z = -(35.7 - 36.0) * 2.5 ≈ 0.75
const startPos = new THREE.Vector3(6.75, 90, 0.75); 
const endPos = new THREE.Vector3(6.75, 35, 0.75);
camera.position.copy(startPos);
camera.up.set(0, 1, 0);  // Always use Y-up throughout app

let animProgress = 0;
const animSpeed = 0.012; 

// ==========================================
// 2. 空間の演出（床のグリッド）とマーカー
// ==========================================
const gridHelper = new THREE.GridHelper(150, 150, 0x000000, 0x000000);
gridHelper.material.opacity = 0.08;
gridHelper.material.transparent = true;
//scene.add(gridHelper);

const markerGeom = new THREE.SphereGeometry(0.002, 16, 16);
const markerMat = new THREE.MeshBasicMaterial({ color: 0xff0044 }); 
let currentMarkerScale = 4;
const currentMarker = new THREE.Mesh(markerGeom, markerMat);
currentMarker.visible = false; 
currentMarker.scale.setScalar(currentMarkerScale);
scene.add(currentMarker);

// ==========================================
// 3. 日本地図（平面）の構築
// ==========================================
const bordersGroup = new THREE.Group();
scene.add(bordersGroup);
const prefectureRevealGroup = new THREE.Group();
scene.add(prefectureRevealGroup);
bordersGroup.visible = true;
prefectureRevealGroup.visible = false;

const borderMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 });
const CENTER_LON = 137.0; 
const CENTER_LAT = 36.0; 
const SCALE = 2.5; 
const PREFECTURE_FILL_TARGET_OPACITY = 0.14;
let followCameraQuaternion = null; // Store fixed rotation for follow mode

// Expose to global scope for trajectory-loader.js
window.CENTER_LON = CENTER_LON;
window.CENTER_LAT = CENTER_LAT;
window.SCALE = SCALE;
window.PREFECTURE_FILL_TARGET_OPACITY = PREFECTURE_FILL_TARGET_OPACITY;

// 出典: 地球地図日本 (dataofjapan/land の japan.geojson を座標丸め・軽量化したもの)
const JAPAN_PREF_JSON_URL = 'data/japan-prefectures.json';
// 出典: Natural Earth (パブリックドメイン)。訪れたら現れるが、都道府県数には数えない
const OVERSEAS_REGION_JSON_URLS = ['data/philippines.json'];
const prefectureRegionData = [];
const overseasRegionNames = new Set();
const isDomesticRegion = (region) => !region.overseas;
const prefectureBorderMeshes = new Map();
const prefectureRevealMeshes = new Map();
const prefectureRevealState = new Map();
let prefectureRevealEnabled = true;
let latestPlaybackTime = null;
let currentTipPos = null;
let cameraMode = 'follow'; // 'free' or 'follow'
let followHeight = 35;
let playbackSpeed = 1.0;
let smoothedTipPos = new THREE.Vector3();
let lastFollowCameraPos = new THREE.Vector3(6.75, 180, 0.75);
let lastFollowTarget = TOKYO_VIEW_TARGET.clone();
const visitedPrefectures = new Set();

// minimap state
const minimapCanvas = document.getElementById('minimap');
let minimapCtx = null;
let japanBounds = null; // {minX,maxX,minZ,maxZ}
// 県境の下絵はテーマごとに一度だけ描いて使い回す (毎フレーム 47 県分の折れ線を描くと重い)
let minimapBaseLayer = null; // { theme, canvas }

function updateMinimapPosition() {
    if (!minimapCanvas) return;
    const mapRightEdge = storyPanel ? storyPanel.getBoundingClientRect().left : window.innerWidth * 0.72;
    const rightOffset = Math.max(18, Math.round(window.innerWidth - mapRightEdge + 18));
    minimapCanvas.style.right = `${rightOffset}px`;
    minimapCanvas.style.top = '18px';
}

function computeJapanBounds() {
    if (!prefectureRegionData.some(isDomesticRegion)) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const visitCoords = (coords) => {
        if (!Array.isArray(coords)) return;
        if (coords.length > 0 && typeof coords[0][0] === 'number') {
            coords.forEach(([lon, lat]) => {
                const x = (lon - CENTER_LON) * SCALE;
                const z = -(lat - CENTER_LAT) * SCALE;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (z < minZ) minZ = z;
                if (z > maxZ) maxZ = z;
            });
            return;
        }
        coords.forEach(visitCoords);
    };
    prefectureRegionData.filter(isDomesticRegion).forEach(region => {
        const coords = region.geometry && region.geometry.coordinates;
        visitCoords(coords);
    });
    if (!isFinite(minX)) return null;
    japanBounds = { minX, maxX, minZ, maxZ };
    return japanBounds;
}

function worldToMinimap(x, z, rect) {
    if (!japanBounds || !minimapCtx) return {x:0,y:0};
    const w = rect.width;
    const h = rect.height;
    const nx = (x - japanBounds.minX) / (japanBounds.maxX - japanBounds.minX);
    const nz = (z - japanBounds.minZ) / (japanBounds.maxZ - japanBounds.minZ);
    return { x: Math.round(rect.x + nx * w), y: Math.round(rect.y + nz * h) };
}

function drawMinimapGeometry(ctx, coords, rect) {
    if (!Array.isArray(coords)) return;
    if (coords.length > 0 && typeof coords[0][0] === 'number') {
        ctx.beginPath();
        coords.forEach((pair, index) => {
            const [lon, lat] = pair;
            const x = (lon - CENTER_LON) * SCALE;
            const z = -(lat - CENTER_LAT) * SCALE;
            const p = worldToMinimap(x, z, rect);
            if (index === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.stroke();
        return;
    }
    coords.forEach(child => drawMinimapGeometry(ctx, child, rect));
}

function getMinimapBaseLayer(rect) {
    if (minimapBaseLayer && minimapBaseLayer.theme === appThemeMode) return minimapBaseLayer.canvas;
    const layer = document.createElement('canvas');
    layer.width = minimapCanvas.width;
    layer.height = minimapCanvas.height;
    const ctx = layer.getContext('2d');
    // background
    ctx.fillStyle = appThemeMode === 'light' ? '#ffffff' : '#0a0f14';
    ctx.fillRect(0, 0, layer.width, layer.height);
    ctx.strokeStyle = appThemeMode === 'light' ? 'rgba(20, 20, 20, 0.35)' : 'rgba(245, 245, 245, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, layer.width - 1, layer.height - 1);
    // draw japan extents
    ctx.strokeStyle = appThemeMode === 'light' ? 'rgba(150, 150, 150, 0.9)' : 'rgba(210, 210, 210, 0.9)';
    ctx.lineWidth = 1;
    prefectureRegionData.filter(isDomesticRegion).forEach(region => {
        const coords = region.geometry && region.geometry.coordinates;
        drawMinimapGeometry(ctx, coords, rect);
    });
    minimapBaseLayer = { theme: appThemeMode, canvas: layer };
    return layer;
}

function updateMinimap() {
    if (!minimapCanvas) return;
    if (!minimapCtx) minimapCtx = minimapCanvas.getContext('2d');
    updateMinimapPosition();
    const rect = { x: 6, y: 6, width: minimapCanvas.width - 12, height: minimapCanvas.height - 12 };
    if (!japanBounds) computeJapanBounds();
    minimapCtx.clearRect(0,0,minimapCanvas.width,minimapCanvas.height);
    if (japanBounds) {
        minimapCtx.drawImage(getMinimapBaseLayer(rect), 0, 0);
        // draw viewport box
        if (window.currentTipPos) {
            const target = window.currentTipPos;
            const camY = camera.position.y;
            const halfHeight = camY * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
            const halfWidth = halfHeight * camera.aspect;
            const x1 = target.x - halfWidth;
            const x2 = target.x + halfWidth;
            const z1 = target.z - halfHeight;
            const z2 = target.z + halfHeight;
            const p1 = worldToMinimap(x1, z2, rect);
            const p2 = worldToMinimap(x2, z1, rect);
            const vw = Math.max(1, p2.x - p1.x);
            const vh = Math.max(1, p2.y - p1.y);
            // draw viewport box fill first
            minimapCtx.fillStyle = appThemeMode === 'light' ? 'rgba(0,120,255,0.15)' : 'rgba(255,200,100,0.14)';
            minimapCtx.fillRect(p1.x, p1.y, vw, vh);
            // then draw border with stronger opacity
            minimapCtx.strokeStyle = appThemeMode === 'light' ? 'rgba(0,120,255,1)' : 'rgba(255,200,100,1)';
            minimapCtx.lineWidth = 2.5;
            minimapCtx.strokeRect(p1.x, p1.y, vw, vh);
        }
    } else {
        minimapCtx.fillStyle = appThemeMode === 'light' ? '#ffffff' : '#0a0f14';
        minimapCtx.fillRect(0,0,minimapCanvas.width,minimapCanvas.height);
        minimapCtx.strokeStyle = appThemeMode === 'light' ? 'rgba(20, 20, 20, 0.35)' : 'rgba(245, 245, 245, 0.35)';
        minimapCtx.lineWidth = 1;
        minimapCtx.strokeRect(0.5, 0.5, minimapCanvas.width - 1, minimapCanvas.height - 1);
        minimapCtx.fillStyle = appThemeMode === 'light' ? '#ffffff' : '#05151b';
        minimapCtx.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
}

function extractPrefectureLabel(properties = {}) {
    const preferredKeys = ['name', 'prefecture', 'prefecture_name', 'name_jp', 'jp_name', 'title', 'label', 'nam', 'N03_001', 'PREF_NAME', 'pref_name', 'name_ja'];
    for (const key of preferredKeys) {
        const value = properties[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }

    const stringValues = Object.values(properties).filter(value => typeof value === 'string' && value.trim());
    const japaneseValue = stringValues.find(value => /[都道府県]/.test(value));
    return japaneseValue || stringValues[0] || '';
}

function makePrefectureShape(ring) {
    const shape = new THREE.Shape();
    ring.forEach((point, index) => {
        const x = (point[0] - CENTER_LON) * SCALE;
        const y = (point[1] - CENTER_LAT) * SCALE;
        if (index === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
    });
    return shape;
}

function registerPrefectureFeature(feature) {
    const label = extractPrefectureLabel(feature.properties || {});
    if (!label) return;

    const overseas = Boolean(feature.properties && feature.properties.overseas);
    prefectureRegionData.push({ name: label, geometry: feature.geometry, overseas });
    if (overseas) overseasRegionNames.add(label);

    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const fillGroup = new THREE.Group();
    const borderGroup = new THREE.Group();

    polygons.forEach(polygon => {
        if (!polygon[0]) return;

        const shape = makePrefectureShape(polygon[0]);
        for (let i = 1; i < polygon.length; i++) {
            if (!polygon[i] || polygon[i].length < 3) continue;
            const hole = new THREE.Path();
            polygon[i].forEach((point, index) => {
                const x = (point[0] - CENTER_LON) * SCALE;
                const y = (point[1] - CENTER_LAT) * SCALE;
                if (index === 0) hole.moveTo(x, y);
                else hole.lineTo(x, y);
            });
            shape.holes.push(hole);
        }

        const geometry = new THREE.ShapeGeometry(shape);
        const material = new THREE.MeshBasicMaterial({
            color: 0x9bd7ff,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.visible = false;
        fillGroup.add(mesh);

        // create border line with white color for dark mode
        const borderPositions = [];
        polygon[0].forEach(c => borderPositions.push(new THREE.Vector3((c[0] - CENTER_LON) * SCALE, 0, -(c[1] - CENTER_LAT) * SCALE)));
        const borderGeom = new THREE.BufferGeometry().setFromPoints(borderPositions);
        const borderLine = new THREE.Line(borderGeom, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, linewidth: 4 }));
        borderLine.visible = false;
        borderGroup.add(borderLine);
    });

    prefectureRevealMeshes.set(label, fillGroup);
    prefectureBorderMeshes.set(label, borderGroup);
    prefectureRevealState.set(label, { current: 0, target: 0 });
    prefectureRevealGroup.add(fillGroup);
    bordersGroup.add(borderGroup);
}

function revealPrefecture(label) {
    if (!prefectureRevealMeshes.has(label)) return;
    const state = prefectureRevealState.get(label);
    if (!state) return;
    state.target = PREFECTURE_FILL_TARGET_OPACITY;

    const fillGroup = prefectureRevealMeshes.get(label);
    fillGroup.visible = true;
    fillGroup.children.forEach(mesh => {
        mesh.visible = true;
    });
    prefectureRevealGroup.visible = prefectureRevealEnabled;
}

function refreshPrefectureRevealGroupVisibility() {
    const hasVisiblePrefecture = prefectureRegionData.some(region => {
        const state = prefectureRevealState.get(region.name);
        return state && state.current > 0.005;
    });

    prefectureRevealGroup.visible = prefectureRevealEnabled && hasVisiblePrefecture;
}

// 県ごとの「初訪問時刻」(ビルド時に計算済み) と比べるだけなので、
// 早送り・巻き戻しどちらでも 47 県分のループで済む
function syncPrefectureRevealToTime(targetTime) {
    if (targetTime == null || !prefectureFirstVisit) return;

    visitedPrefectures.clear();
    for (const name in prefectureFirstVisit) {
        if (prefectureFirstVisit[name] <= targetTime) visitedPrefectures.add(name);
    }
    prefectureRevealState.forEach((state, name) => {
        state.target = visitedPrefectures.has(name) ? PREFECTURE_FILL_TARGET_OPACITY : 0;
    });
}

function updatePrefectureRevealAnimation() {
    prefectureRegionData.forEach(region => {
        const state = prefectureRevealState.get(region.name);
        const fillGroup = prefectureRevealMeshes.get(region.name);
        if (!state || !fillGroup) return;

        state.current += (state.target - state.current) * 0.08;
        const showNow = prefectureRevealEnabled && state.current > 0.005;
        fillGroup.visible = showNow;
        fillGroup.children.forEach(mesh => {
            mesh.material.opacity = state.current;
            mesh.visible = showNow;
        });

        const borderGroup = prefectureBorderMeshes.get(region.name);
        if (borderGroup) {
            borderGroup.children.forEach(line => {
                if (line.material) line.material.opacity = state.current;
                line.visible = showNow;
            });
        }
    });

    refreshPrefectureRevealGroupVisibility();
}

function loadRegionGeoJSON(url) {
    return fetch(url)
        .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        })
        .then(data => {
            data.features.forEach(feature => {
                if (!feature.geometry) return;
                registerPrefectureFeature(feature);
            });
            japanBounds = null;
            minimapBaseLayer = null; // 県境が揃ったのでミニマップの下絵を作り直す
            if (latestPlaybackTime != null) syncPrefectureRevealToTime(latestPlaybackTime);
            return data;
        })
        .catch((error) => {
            console.warn(`${url} failed to load; continuing without it.`, error);
            return null;
        });
}

const prefectureDataPromise = loadRegionGeoJSON(JAPAN_PREF_JSON_URL);
OVERSEAS_REGION_JSON_URLS.forEach(loadRegionGeoJSON);

function drawPolygon(coords, group) {
    if (!coords[0]) return;
    const vertices = [];
    coords[0].forEach(c => vertices.push(new THREE.Vector3((c[0] - CENTER_LON) * SCALE, 0, -(c[1] - CENTER_LAT) * SCALE)));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(vertices), borderMaterial));
}

// ==========================================
// 4. データ読み込みと厳密な距離計算・描画
// ==========================================
const ALT_SCALE = 0.0003; 
const BASE_HEIGHT = 0.05; 

// Expose to global scope for trajectory-loader.js
window.ALT_SCALE = ALT_SCALE;
window.BASE_HEIGHT = BASE_HEIGHT; 

const TIME_UNIV_1 = new Date('2024-03-10T00:00:00').getTime();
const TIME_UNIV_2 = new Date('2025-03-31T00:00:00').getTime();
const TIME_UNIV_3 = new Date('2026-04-01T00:00:00').getTime();

const COLOR_HS = new THREE.Color(0xff0044); 
const COLOR_U1 = new THREE.Color(0x00d2ff); 
const COLOR_U2 = new THREE.Color(0x7fd36a); 
const COLOR_U3 = new THREE.Color(0xb36bff);
let showPrefectureReveal = true;

// リザルト画面などで使う時期の一覧 (getEraCode の並びと対応)
const ERA_INFO = [
    { code: 'hs', label: '高校', color: '#ff0044' },
    { code: 'u1', label: '大学1年', color: '#00d2ff' },
    { code: 'u2', label: '大学2年', color: '#7fd36a' },
    { code: 'u3', label: '大学3年', color: '#b36bff' },
];

function getEraCode(t) {
    if (t < TIME_UNIV_1) return 'hs';
    if (t < TIME_UNIV_2) return 'u1';
    if (t < TIME_UNIV_3) return 'u2';
    return 'u3';
}

function getColorByTime(t) {
    if (t < TIME_UNIV_1) return COLOR_HS;
    if (t < TIME_UNIV_2) return COLOR_U1;
    if (t < TIME_UNIV_3) return COLOR_U2;
    return COLOR_U3;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

const trajectoryGroup = new THREE.Group();
scene.add(trajectoryGroup);
const eraGroups = { hs: new THREE.Group(), u1: new THREE.Group(), u2: new THREE.Group(), u3: new THREE.Group() };
trajectoryGroup.add(eraGroups.hs);
trajectoryGroup.add(eraGroups.u1);
trajectoryGroup.add(eraGroups.u2);
trajectoryGroup.add(eraGroups.u3);

const heatmapGroup = new THREE.Group();
scene.add(heatmapGroup);
heatmapGroup.visible = false;

// Expose to global scope for trajectory-loader.js
window.trajectoryGroup = trajectoryGroup;
window.eraGroups = eraGroups;
window.heatmapGroup = heatmapGroup; 

// ==========================================
// 5. UI操作 ＆ アニメーション
// ==========================================
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.05; controls.target.copy(TOKYO_VIEW_TARGET); controls.enabled = false;
controls.enableRotate = true;
controls.enablePan = true;
controls.enableZoom = false;
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
controls.zoomSpeed = 1.0;

const interactionSettings = {
    pan: { mouse: '左ドラッグ', gesture: '1本指ドラッグ' },
    rotate: { mouse: '右ドラッグ', gesture: '2本指の回転' },
    zoom: { mouse: 'ホイール', gesture: 'ピンチ操作' },
    help: { key: 'H', closeKey: 'Esc' }
};

const helpButton = document.getElementById('help-button');
const themeToggleButton = document.getElementById('theme-toggle-button');
const helpModal = document.getElementById('help-modal');
const helpBackdrop = document.getElementById('help-backdrop');
const helpCloseButton = document.getElementById('help-close-button');
const helpSummary = document.getElementById('help-summary');
const helpActionList = document.getElementById('help-action-list');
const storyPanel = document.getElementById('story-panel');
const sidePanel = document.getElementById('side-panel');

try {
    const storedThemeMode = localStorage.getItem('journey-theme-mode');
    if (storedThemeMode === 'light') {
        applySceneTheme('light', false);
    } else {
        applySceneTheme('dark', false);
    }
} catch (error) {
    applySceneTheme('dark', false);
}

function renderHelpModal() {
    if (!helpSummary || !helpActionList) return;

    helpSummary.textContent = `現在の設定: 左ドラッグで移動、右ドラッグで回転、ホイールでカーソル位置にズーム`;
    helpActionList.innerHTML = [
        { title: '移動', detail: `${interactionSettings.pan.mouse} / ${interactionSettings.pan.gesture}` },
        { title: '回転', detail: `${interactionSettings.rotate.mouse} / ${interactionSettings.rotate.gesture}` },
        { title: 'ズーム', detail: `${interactionSettings.zoom.mouse} / ${interactionSettings.zoom.gesture}。ズームはカーソル位置を中心に動きます` },
        { title: 'ヘルプ', detail: `<span class="keycap">${interactionSettings.help.key}</span> で表示、<span class="keycap">${interactionSettings.help.closeKey}</span> で閉じる` }
    ].map(item => `<li><strong>${item.title}</strong><span>${item.detail}</span></li>`).join('');
}

function openHelpModal() {
    renderHelpModal();
    if (helpModal) helpModal.classList.add('visible');
    if (helpBackdrop) helpBackdrop.classList.add('visible');
}

function closeHelpModal() {
    if (helpModal) helpModal.classList.remove('visible');
    if (helpBackdrop) helpBackdrop.classList.remove('visible');
}

// ---------- リザルト (時期ごとの移動距離) ----------
const resultButton = document.getElementById('result-button');
const resultModal = document.getElementById('result-modal');
const resultCloseButton = document.getElementById('result-close-button');
const resultTotal = document.getElementById('result-total');
const resultEraList = document.getElementById('result-era-list');
let resultShownAfterPlayback = false;
// リザルトに載せる時期 (高校は含めない)。合計・割合もこの時期だけで計算する
const RESULT_ERA_CODES = ['u1', 'u2', 'u3'];

const formatDate = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
const formatKm = (km) => Math.round(km).toLocaleString();

function computeEraSummary() {
    if (!trajectoryTimes || trajectoryTimes.length === 0) return null;
    const n = trajectoryTimes.length;
    const eras = ERA_INFO.map(info => ({ ...info, first: -1, last: -1, km: 0, flights: 0, newPrefectures: 0, overseas: [] }));
    const byCode = Object.fromEntries(eras.map(era => [era.code, era]));

    // 時刻は昇順なので、時期ごとに最初と最後の点を拾えば累積距離の差で距離が出る
    for (let i = 0; i < n; i++) {
        const era = byCode[getEraCode(trajectoryTimes[i])];
        if (era.first < 0) era.first = i;
        era.last = i;
    }
    eras.forEach(era => {
        if (era.first < 0) return;
        const before = era.first > 0 ? trajectoryCumulativeKm[era.first - 1] : 0;
        era.km = trajectoryCumulativeKm[era.last] - before;
    });
    flightDepartureTimes.forEach(t => { byCode[getEraCode(t)].flights++; });
    Object.entries(prefectureFirstVisit || {}).forEach(([name, t]) => {
        const era = byCode[getEraCode(t)];
        if (overseasRegionNames.has(name)) era.overseas.push(name);
        else era.newPrefectures++;
    });

    const shown = eras.filter(era => era.first >= 0 && RESULT_ERA_CODES.includes(era.code));
    if (shown.length === 0) return null;
    return {
        eras: shown,
        totalKm: shown.reduce((sum, era) => sum + era.km, 0),
        firstTime: trajectoryTimes[shown[0].first],
        lastTime: trajectoryTimes[shown[shown.length - 1].last],
    };
}

function renderResultModal() {
    const summary = computeEraSummary();
    if (!summary || !resultTotal || !resultEraList) return;
    const maxKm = Math.max(...summary.eras.map(era => era.km), 1);

    resultTotal.innerHTML = `
        <span class="result-total-label">大学での総移動距離</span>
        <span class="result-total-value">${formatKm(summary.totalKm)}<span class="result-unit"> km</span></span>
        <span class="result-period">${formatDate(summary.firstTime)} 〜 ${formatDate(summary.lastTime)}</span>`;

    resultEraList.innerHTML = summary.eras.map(era => {
        const notes = [];
        if (era.flights > 0) notes.push(`飛行機 ${era.flights} 回`);
        notes.push(`初めて訪れた都道府県 ${era.newPrefectures}`);
        if (era.overseas.length > 0) notes.push(`海外: ${era.overseas.join('、')}`);
        const share = summary.totalKm > 0 ? Math.round((era.km / summary.totalKm) * 100) : 0;
        return `
            <li class="result-era" style="--era-color: ${era.color}">
                <div class="result-era-head">
                    <span class="result-era-name"><span class="color-dot"></span>${era.label}</span>
                    <span class="result-era-km">${formatKm(era.km)}<span class="result-unit"> km</span></span>
                </div>
                <div class="result-bar"><span style="width: ${(era.km / maxKm) * 100}%"></span></div>
                <div class="result-era-meta">
                    <span>${formatDate(trajectoryTimes[era.first])} 〜 ${formatDate(trajectoryTimes[era.last])}</span>
                    <span>${share}%</span>
                </div>
                <div class="result-era-notes">${notes.join(' · ')}</div>
            </li>`;
    }).join('');
}

// ---------- 旅の記録 (data/trips.json) ----------
const TRIP_KINDS = [
    { kind: 'travel', label: '旅行' },
    { kind: 'detour', label: '寄り道' },
    { kind: 'homecoming', label: '帰省' },
    { kind: 'nearby', label: '近場' },
];
const resultTrips = document.getElementById('result-trips');
const resultTripTabs = document.getElementById('result-trip-tabs');
const resultTripList = document.getElementById('result-trip-list');
let tripRecords = [];
let selectedTripKind = 'travel';

fetch('data/trips.json')
    .then(response => (response.ok ? response.json() : null))
    .then(data => {
        tripRecords = (data && Array.isArray(data.trips)) ? data.trips : [];
        if (resultModal && resultModal.classList.contains('visible')) renderTripSection();
    })
    .catch(error => console.warn('trips.json failed to load', error));

// 'YYYY-MM-DD' を日本時間のその日 0 時として扱う
const tripDateToTime = (ymd) => new Date(`${ymd}T00:00:00+09:00`).getTime();

function formatTripRange(trip) {
    const [sy, sm, sd] = trip.start.split('-').map(Number);
    const [ey, em, ed] = trip.end.split('-').map(Number);
    if (trip.start === trip.end) return `${sy}/${sm}/${sd}`;
    return `${sy}/${sm}/${sd}〜${ey !== sy ? `${ey}/` : ''}${em}/${ed}`;
}

function renderTripSection() {
    if (!resultTrips || !resultTripTabs || !resultTripList) return;
    resultTrips.hidden = tripRecords.length === 0;
    if (tripRecords.length === 0) return;

    resultTripTabs.innerHTML = TRIP_KINDS.map(({ kind, label }) => {
        const items = tripRecords.filter(trip => trip.kind === kind);
        const nights = items.reduce((sum, trip) => sum + (trip.nights || 0), 0);
        const active = kind === selectedTripKind;
        return `<button type="button" role="tab" class="result-trip-tab${active ? ' active' : ''}" data-kind="${kind}" aria-selected="${active}">
            <span class="result-trip-tab-label">${label}</span>
            <span class="result-trip-tab-count">${items.length}<small>回</small></span>
            <span class="result-trip-tab-nights">${nights}泊</span>
        </button>`;
    }).join('');

    resultTripList.innerHTML = tripRecords
        .map((trip, index) => ({ trip, index }))
        .filter(({ trip }) => trip.kind === selectedTripKind)
        .map(({ trip, index }) => `
            <li><button type="button" class="result-trip-row" data-index="${index}">
                <span class="result-trip-date">${formatTripRange(trip)}</span>
                <span class="result-trip-place">${trip.place}</span>
                <span class="result-trip-nights">${trip.nights > 0 ? `${trip.nights}泊` : '日帰り'}</span>
            </button></li>`)
        .join('');
}

// 指定した時刻に対応する再生位置 (頂点の通し番号) を探す
function progressForTime(time) {
    for (const line of trajectoryLines) {
        if (line.times[line.count - 1] < time) continue;
        let low = 0;
        let high = line.count - 1;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (line.times[mid] >= time) high = mid;
            else low = mid + 1;
        }
        return line.startIndex + low + 1;
    }
    return totalVertices;
}

function playFromTime(time) {
    if (totalVertices <= 0) return;
    currentProgress = Math.min(totalVertices, progressForTime(time));
    if (seekBar) seekBar.value = currentProgress;
    updateTrajectory(currentProgress);
    // フォローカメラが日本列島を横切ってゆっくり移動しないよう、追従位置を一気に合わせる
    if (window.currentTipPos) smoothedTipPos.copy(window.currentTipPos);
    isPlaying = true;
    if (playBtn) playBtn.innerText = '⏸';
    closeResultModal();
}

if (resultTripTabs) {
    resultTripTabs.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-kind]');
        if (!tab) return;
        selectedTripKind = tab.dataset.kind;
        renderTripSection();
    });
}
if (resultTripList) {
    resultTripList.addEventListener('click', (event) => {
        const row = event.target.closest('[data-index]');
        if (!row) return;
        const trip = tripRecords[Number(row.dataset.index)];
        if (trip) playFromTime(tripDateToTime(trip.start));
    });
}

function openResultModal() {
    renderResultModal();
    renderTripSection();
    closeHelpModal();
    if (resultModal) resultModal.classList.add('visible');
    if (helpBackdrop) helpBackdrop.classList.add('visible');
}

function closeResultModal() {
    if (resultModal) resultModal.classList.remove('visible');
    if (helpBackdrop && !(helpModal && helpModal.classList.contains('visible'))) helpBackdrop.classList.remove('visible');
}

if (resultButton) resultButton.addEventListener('click', openResultModal);
if (resultCloseButton) resultCloseButton.addEventListener('click', closeResultModal);

if (helpButton) helpButton.addEventListener('click', openHelpModal);
if (helpBackdrop) helpBackdrop.addEventListener('click', () => { closeHelpModal(); closeResultModal(); });
if (helpCloseButton) helpCloseButton.addEventListener('click', closeHelpModal);
if (themeToggleButton) {
    themeToggleButton.addEventListener('click', () => {
        applySceneTheme(appThemeMode === 'light' ? 'dark' : 'light');
    });
}

window.addEventListener('keydown', (event) => {
    if (event.key === interactionSettings.help.key || event.key === interactionSettings.help.key.toLowerCase()) openHelpModal();
    // event.key は 'Escape' (古いブラウザは 'Esc')
    if (event.key === 'Escape' || event.key === 'Esc') { closeHelpModal(); closeResultModal(); }
});

const wheelRaycaster = new THREE.Raycaster();
const zoomPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

renderer.domElement.addEventListener('wheel', (event) => {
    if (cameraMode === 'follow') {
        event.preventDefault();
        event.stopPropagation();
        const zoomFactor = Math.pow(0.95, -event.deltaY / 40);
        const minY = 2;
        const maxY = 1200;
        followHeight = Math.max(minY, Math.min(maxY, followHeight * zoomFactor));
        return;
    }

    if (!controls.enabled) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    wheelRaycaster.setFromCamera(pointer, camera);
    const zoomPoint = new THREE.Vector3();
    const hasHit = wheelRaycaster.ray.intersectPlane(zoomPlane, zoomPoint) !== null;
    if (!hasHit) zoomPoint.copy(controls.target);

    const zoomFactor = Math.pow(0.95, -event.deltaY / 40);

    {
        camera.position.sub(zoomPoint).multiplyScalar(zoomFactor).add(zoomPoint);
        controls.target.sub(zoomPoint).multiplyScalar(zoomFactor).add(zoomPoint);
        controls.update();
    }
}, { passive: false });

const seekBar = document.getElementById('seek-bar');
const playBtn = document.getElementById('play-pause-btn');
const timeDisp = document.getElementById('time-display');
const playbackSpeedSlider = document.getElementById('playback-speed-slider');
const playbackSpeedValue = document.getElementById('playback-speed-value');
const dashboardDate = document.getElementById('dashboard-date');
const visitedPrefectureCount = document.getElementById('visited-prefecture-count');
const prefectureTotalCount = document.getElementById('prefecture-total-count');
const dashboardProgress = document.getElementById('dashboard-progress');
const playbackControls = document.getElementById('playback-controls');
const statsHeader = document.getElementById('stats-header');

let isPlaying = true;
let currentProgress = 0; 

function updateDashboardStats(currentTime) {
    if (visitedPrefectureCount) {
        let domesticVisited = 0;
        visitedPrefectures.forEach(name => { if (!overseasRegionNames.has(name)) domesticVisited++; });
        visitedPrefectureCount.textContent = String(domesticVisited);
    }
    if (prefectureTotalCount) {
        const domesticTotal = prefectureRegionData.filter(isDomesticRegion).length;
        prefectureTotalCount.textContent = domesticTotal > 0 ? String(domesticTotal) : '--';
    }
    if (dashboardProgress) {
        const percent = totalVertices > 0 ? Math.min(100, Math.max(0, Math.round((currentProgress / totalVertices) * 100))) : 0;
        dashboardProgress.textContent = `${percent}%`;
    }
    if (dashboardDate) {
        if (currentTime) {
            const d = new Date(currentTime);
            dashboardDate.textContent = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } else {
            dashboardDate.textContent = '--/--/-- --:--';
        }
    }
}

['hs', 'u1', 'u2', 'u3'].forEach(era => {
    document.getElementById(`toggle-${era}`).addEventListener('change', (e) => {
        eraGroups[era].visible = e.target.checked;
        updateTrajectory(currentProgress); 
    });
});

if (playBtn) {
    playBtn.addEventListener('click', () => { isPlaying = !isPlaying; playBtn.innerText = isPlaying ? "⏸" : "▶"; });
}
if (seekBar) {
    seekBar.addEventListener('input', (e) => {
        currentProgress = parseFloat(e.target.value);
        updateTrajectory(currentProgress);
        isPlaying = false; playBtn.innerText = "▶";
        updateDashboardStats(latestPlaybackTime);
    });
}

const cameraModeFollowBtn = document.getElementById('camera-mode-follow');
const cameraModeFreeBtn = document.getElementById('camera-mode-free');

function setCameraMode(mode) {
    cameraMode = mode === 'follow' ? 'follow' : 'free';
    window.cameraMode = cameraMode;

    if (cameraMode === 'follow') {
        followHeight = Math.max(2, Math.min(1200, camera.position.y || followHeight));
        controls.enabled = false;
        controls.enableRotate = false;
        controls.enablePan = false;
        controls.enableZoom = false;

        // Follow mode: pure top-down view, north (-Z) at top of screen.
        // Use Y-up consistently (never change up vector), but compute quaternion for top-down look
        camera.up.set(0, 1, 0);  // Always Y-up
        const followTarget = window.currentTipPos || controls.target || new THREE.Vector3(0, 0, 0);
        camera.position.set(followTarget.x, followTarget.y + followHeight, followTarget.z);
        camera.lookAt(followTarget.x, followTarget.y, followTarget.z);
        followCameraQuaternion = camera.quaternion.clone();

        cameraModeFollowBtn?.classList.add('active');
        cameraModeFreeBtn?.classList.remove('active');
    } else {
        controls.enabled = true;
        controls.enableRotate = true;
        controls.enablePan = true;
        controls.enableZoom = true;

        // Free mode: restore OrbitControls with last saved pose
        // Reset OrbitControls internal state to avoid gimbal lock artifacts
        controls.reset();
        
        const pos = lastFollowCameraPos.clone();
        const tgt = lastFollowTarget.clone();
        
        // Ensure camera is not directly overhead to avoid gimbal lock
        // Slightly tilt toward south so azimuth can be properly calculated
        if (Math.abs(pos.x - tgt.x) < 0.05 && Math.abs(pos.z - tgt.z) < 0.05) {
            pos.z = tgt.z + 0.05;  // tilt slightly south for valid azimuth
        }
        
        camera.position.copy(pos);
        camera.up.set(0, 1, 0);
        camera.lookAt(tgt);
        controls.target.copy(tgt);
        controls.update();

        cameraModeFollowBtn?.classList.remove('active');
        cameraModeFreeBtn?.classList.add('active');
    }
}

if (cameraModeFollowBtn) cameraModeFollowBtn.addEventListener('click', () => setCameraMode('follow'));
if (cameraModeFreeBtn) cameraModeFreeBtn.addEventListener('click', () => setCameraMode('free'));

if (playbackSpeedSlider) {
    const applyPlaybackSpeed = (v) => {
        playbackSpeed = parseFloat(v) || 1.0;
        if (playbackSpeedValue) playbackSpeedValue.textContent = `${playbackSpeed.toFixed(2)}x`;
    };
    applyPlaybackSpeed(playbackSpeedSlider.value || '1.0');
    playbackSpeedSlider.addEventListener('input', (e) => applyPlaybackSpeed(e.target.value));
}

// Fixed marker size and bloom exposure
currentMarkerScale = 12;
currentMarker.scale.setScalar(currentMarkerScale);

bloomPass.strength = appThemeMode === 'light' ? 0 : 0.7;

function updateTrajectory(progress) {
    let currentTime = null;

    trajectoryLines.forEach(line => {
        if (progress >= line.startIndex + line.count) {
            line.geometry.setDrawRange(0, line.count);
            if (line.glowLine) {
                line.glowLine.geometry.setDrawRange(0, line.count);
                line.glowLine.visible = appThemeMode !== 'light';
            }
            currentTime = line.times[line.count - 1];
            const pos = line.geometry.attributes.position;
            currentTipPos = new THREE.Vector3(pos.getX(line.count-1), pos.getY(line.count-1), pos.getZ(line.count-1));
        } else if (progress > line.startIndex) {
            const localCount = Math.floor(progress - line.startIndex);
            line.geometry.setDrawRange(0, localCount);
            if (line.glowLine) {
                line.glowLine.geometry.setDrawRange(0, localCount);
                line.glowLine.visible = appThemeMode !== 'light';
            }
            if (localCount > 0) {
                currentTime = line.times[localCount - 1];
                const pos = line.geometry.attributes.position;
                currentTipPos = new THREE.Vector3(pos.getX(localCount-1), pos.getY(localCount-1), pos.getZ(localCount-1));
            }
        } else {
            line.geometry.setDrawRange(0, 0);
            if (line.glowLine) line.glowLine.geometry.setDrawRange(0, 0);
        }
    });

    // expose current tip position globally for follow-camera mode
    window.currentTipPos = currentTipPos;
    // initialize smoothed tip position once when available to avoid jump
    if (currentTipPos && smoothedTipPos.lengthSq() === 0) {
        smoothedTipPos.copy(currentTipPos);
    }

    if (currentTipPos && trajectoryGroup.visible) {
        const tipEra = getEraCode(currentTime);
        if (eraGroups[tipEra].visible) {
            currentMarker.position.copy(currentTipPos);
            currentMarker.visible = true; 
        } else {
            currentMarker.visible = false;
        }
    } else {
        currentMarker.visible = false;
    }

    if (currentTime && timeDisp) {
        latestPlaybackTime = currentTime;
        syncPrefectureRevealToTime(currentTime);

        const d = new Date(currentTime);
        timeDisp.innerText = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

        if (currentTime < TIME_UNIV_1) currentMarker.material.color.setHex(0xff0044);
        else if (currentTime < TIME_UNIV_2) currentMarker.material.color.setHex(0x00d2ff);
        else if (currentTime < TIME_UNIV_3) currentMarker.material.color.setHex(0xccff00);
        else currentMarker.material.color.setHex(0xb36bff);

        // 現在時刻までの累積距離 (trajectory-loader.js で二分探索)
        const currentDist = getCumulativeDistanceAt(currentTime);
        document.getElementById('ui-total-dist').innerHTML =
            `${Math.floor(currentDist).toLocaleString()} <span style="font-size: 12px; color: #aaaaaa;">km</span>`;
    }

    updateDashboardStats(currentTime || latestPlaybackTime);

    updatePrefectureRevealAnimation();
}

function animate() {
    requestAnimationFrame(animate);

    if (animProgress < 1) {
        animProgress += animSpeed;
        if (animProgress > 1) animProgress = 1;
        let easeInOut = (animProgress < 0.5) ? 4 * Math.pow(animProgress, 3) : 1 - Math.pow(-2 * animProgress + 2, 3) / 2;
        camera.position.lerpVectors(startPos, endPos, easeInOut);
        camera.lookAt(TOKYO_VIEW_TARGET.x, TOKYO_VIEW_TARGET.y, TOKYO_VIEW_TARGET.z);

        if (animProgress === 1) {
            setCameraMode('follow');
            if (storyPanel) storyPanel.classList.remove('hidden');
            if (playbackControls) playbackControls.classList.remove('hidden');
            if (statsHeader) statsHeader.classList.remove('hidden');
            if (sidePanel) sidePanel.classList.remove('hidden');
        }
    }

    if (animProgress === 1 && isPlaying && totalVertices > 0) {
        if (currentProgress < totalVertices) {
            currentProgress += 0.5 * playbackSpeed; 
            if (seekBar) seekBar.value = currentProgress;
            updateTrajectory(currentProgress);
        } else {
            isPlaying = false;
            if (playBtn) playBtn.innerText = "▶";
            // 最後まで再生しきったら一度だけリザルトを出す
            if (!resultShownAfterPlayback) {
                resultShownAfterPlayback = true;
                openResultModal();
            }
        }
    }

    // follow-mode: keep camera positioned relative to a smoothed tip to avoid jitter
    if (animProgress === 1 && cameraMode === 'follow' && window.currentTipPos) {
        // smooth the tip position first
        smoothedTipPos.lerp(window.currentTipPos, 0.05); // lower factor => smoother
        const target = smoothedTipPos;
        const desiredPos = new THREE.Vector3(target.x, target.y + followHeight, target.z);
        camera.position.lerp(desiredPos, 0.18);
        // Keep rotation completely fixed (north up, looking straight down)
        if (followCameraQuaternion) {
            camera.quaternion.copy(followCameraQuaternion);
        }
        camera.up.set(0, 1, 0);  // Maintain Y-up
        controls.target.copy(target);
        // store for pose persistence when exiting follow mode
        lastFollowCameraPos.copy(camera.position);
        lastFollowTarget.copy(target);
    } else if (animProgress === 1 && cameraMode === 'follow' && !window.currentTipPos) {
        const followTarget = controls.target || new THREE.Vector3(0, 0, 0);
        const desiredPos = new THREE.Vector3(followTarget.x, followTarget.y + followHeight, followTarget.z);
        camera.position.lerp(desiredPos, 0.18);
        // Keep rotation completely fixed
        if (followCameraQuaternion) {
            camera.quaternion.copy(followCameraQuaternion);
        }
        camera.up.set(0, 1, 0);  // Maintain Y-up
        // store for pose persistence when exiting follow mode
        lastFollowCameraPos.copy(camera.position);
        lastFollowTarget.copy(followTarget);
    }

    if (cameraMode === 'free') {
        controls.update();
    }
    updatePrefectureRevealAnimation();
    updateMinimap();
    composer.render();
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

animate();