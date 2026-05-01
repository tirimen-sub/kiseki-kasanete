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

## 補足

- このサイトは静的ファイルのみで動作します
- CSV は `260319_aslog.csv` を相対パスで読み込むため、GitHub Pages でもそのまま動きます
- `raw.githubusercontent.com` の地図データに依存しているため、その配信元が落ちていると地図の読み込みに影響します