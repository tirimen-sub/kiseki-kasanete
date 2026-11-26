# キセキ・カサネテ

Three.js ベースの移動ログ可視化サイトです。`main` ブランチへ push すると GitHub Pages に自動公開される構成にしています。

## 公開手順

1. GitHub で空のリポジトリを作成する
2. このフォルダをそのリポジトリに接続する
3. `main` ブランチへ push する
4. GitHub の `Settings > Pages` で `Build and deployment` を `GitHub Actions` にする

PowerShell 例:

```powershell
git remote add origin https://github.com/<your-name>/<your-repo>.git
git add .
git commit -m "Initial publish setup"
git push -u origin main
```

## 更新方法

```powershell
git add .
git commit -m "Update site"
git push
```

push 後、GitHub Actions が走って Pages が自動更新されます。

## 移動ログ (CSV) を差し替えたとき

サイトは CSV を直接読まず、前処理済みの `data/trajectory.bin.gz` を読み込みます。
CSV を更新したら、次のコマンドで作り直してからコミットしてください (Node.js 18 以降、追加パッケージ不要)。

```powershell
node tools/build-data.mjs
```

別名の CSV を使う場合は `node tools/build-data.mjs ファイル名.csv` のように指定します。

このスクリプトがやっていること:

- CSV のパースと時刻順ソート
- 累積移動距離の計算
- 各都道府県に初めて入った時刻の判定
- 緯度経度などを差分符号化して gzip 圧縮 (約 45MB → 約 2.5MB)

## ローカルで確認する

`fetch` を使うので、`index.html` をダブルクリックではなく簡易サーバー経由で開きます。

```powershell
python -m http.server 8000
```

ブラウザで http://localhost:8000/ を開きます。

## 補足

- このサイトは静的ファイルのみで動作します
- Pages に公開されるのは `index.html` / `style.css` / `main.js` / `trajectory-loader.js` / `data/` だけです (元の CSV は公開されません)
- 県境データ `data/japan-prefectures.json` は [dataofjapan/land](https://github.com/dataofjapan/land) の `japan.geojson` の座標を小数 4 桁に丸めて軽量化したものです。出典: 地球地図日本 (国土地理院)
- Three.js は unpkg から読み込んでいます
