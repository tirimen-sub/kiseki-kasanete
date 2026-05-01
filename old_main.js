// ==========================================
// 1. 基本設定（シーン・カメラ・レンダラー）
// ==========================================
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio); 
document.getElementById('canvas-container').appendChild(renderer.domElement);

// 初期カメラ位置（★変更：はるか上空・手前にセット）
camera.position.set(0, 200, 150);

// ==========================================
// 2. 空間の演出（床のグリッド）
// ==========================================
// 球の代わりに、床に幾何学的なグリッドを敷いて空間を演出します
const gridHelper = new THREE.GridHelper(150, 150, 0x000000, 0x000000);
gridHelper.material.opacity = 0.04; // うっすらと表示
gridHelper.material.transparent = true;
scene.add(gridHelper);

// ==========================================
// 3. 日本地図（平面）の構築
// ==========================================
const bordersGroup = new THREE.Group();
scene.add(bordersGroup);

const borderMaterial = new THREE.LineBasicMaterial({ 
    color: 0x000000,
    transparent: true,
    opacity: 0.5 // 高精細なので少し濃い目に
});

// 日本の中心座標（緯度・経度）とスケール調整
const CENTER_LON = 137.0; // 日本のだいたい真ん中
const CENTER_LAT = 36.0;
const SCALE = 2.5; // 地図の大きさ

const JAPAN_PREF_JSON_URL = 'https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson';

d3.json(JAPAN_PREF_JSON_URL).then(data => {
    data.features.forEach(feature => {
        if (!feature.geometry) return;
        const coords = feature.geometry.coordinates;
        const type = feature.geometry.type;

        if (type === "Polygon") {
            drawPolygon(coords, bordersGroup);
        } else if (type === "MultiPolygon") {
            coords.forEach(polygon => drawPolygon(polygon, bordersGroup));
        }
    });
    console.log("高精度な日本平面地図の読み込み完了！");
}).catch(err => console.error("Map Data Load Error:", err));

// ★変更：緯度経度を「平面のX, Z座標」に直接変換
function drawPolygon(coords, group) {
    if (!coords[0]) return;
    const vertices = [];
    coords[0].forEach(coord => {
        const [lon, lat] = coord;
        
        // 経度をX軸（左右）、緯度をZ軸（奥行き）にマッピング
        const x = (lon - CENTER_LON) * SCALE;
        const y = 0; // 高さは0で平らな地図に
        const z = -(lat - CENTER_LAT) * SCALE; // Z軸マイナス方向が北（奥）になるように
        
        vertices.push(new THREE.Vector3(x, y, z));
    });
    const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
    const line = new THREE.Line(geometry, borderMaterial);
    group.add(line);
}

// ==========================================
// 4. アニメーションとマウス操作
// ==========================================
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(0, 0, 0);

// ★ここを追加：マウスボタンの左右の役割を入れ替える
controls.mouseButtons = {
    LEFT: THREE.MOUSE.PAN,     // 左クリック（ドラッグ）を「平行移動」に
    MIDDLE: THREE.MOUSE.DOLLY, // センターホイールクリックは「ズーム」のまま
    RIGHT: THREE.MOUSE.ROTATE  // 右クリック（ドラッグ）を「回転」に
};

// --- ★今回追加：オープニングアニメーション設定 ---

// 演出が終わるまではマウス操作を無効にしておく
controls.enabled = false; 

const startPos = new THREE.Vector3(0, 200, 150); // スタート位置（上部のcamera.positionと合わせる）
const endPos = new THREE.Vector3(0, 35, 40);     // ゴール位置（いつもの見下ろし視点）
let animProgress = 0; // 0から1まで増える進行度
const animSpeed = 0.008; // アニメーションの速度（数値を小さくするとゆっくりになる）

function animate() {
    requestAnimationFrame(animate);

    // カメラのオープニング移動
    if (animProgress < 1) {
        animProgress += animSpeed;
        if (animProgress > 1) animProgress = 1;

        // イーズアウト（Cubic）の数式：最初は速く、終盤はゆっくりに
        const easeOut = 1 - Math.pow(1 - animProgress, 3);

        // スタートからゴールへ、easeOutの割合で滑らかに移動させる
        camera.position.lerpVectors(startPos, endPos, easeOut);
        
        // 移動中も常に中心（日本）を見つめ続ける
        camera.lookAt(0, 0, 0);

        // 目的地に到着したら、マウス操作を解禁する
        if (animProgress === 1) {
            controls.enabled = true;
        }
    }

    controls.update();
    renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();