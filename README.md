# Local Video Compressor（ローカル動画圧縮ツール）

![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933)
![FFmpeg](https://img.shields.io/badge/FFmpeg-required-007808)
![License](https://img.shields.io/badge/license-MIT-blue)

**完全ローカル・外部アップロード不要・`npm install` 不要**で、動画を目標ファイルサイズ（**20MB以下 / 10MB以下 / 8MB以下**など）や別フォーマットへ素早く圧縮・変換できるツールです。

Discord・LINE・X・メール添付などのファイルサイズ制限に収めたいときに、Webアプリでもドラッグ＆ドロップ用 `.bat` でもすぐ使えます。

---

## 主な特徴

- **完全ローカル処理**: すべての処理が自分のPC内（`127.0.0.1`）で完結。動画を外部サーバーへ送信しません。
- **ゼロ依存（Zero Dependencies）**: Node.js 標準モジュールのみで動作するため `npm install` 不要。ダウンロードして即起動できます。
- **目標サイズ自動最適化**:
  - プリセット（`8MB` / `10MB` / `20MB` / `25MB` / `50MB` / `100MB` / カスタム）を指定すると、動画の長さから映像・音声ビットレートと解像度を自動計算。
  - **高精度 2-pass エンコード** ＋ 万が一サイズを超えた場合の**自動微調整リトライ**で目標サイズ以下に収めます。
  - 元動画より大きいサイズを指定してもファイルが膨らまない**膨張防止キャップ**付き。
- **GPU 高速エンコード自動検出**: NVIDIA NVENC / Intel QSV / AMD AMF を起動時に自動判定（H.264 / HEVC を個別チェック）。
- **多彩な出力・編集オプション**:
  - 出力形式: `MP4 (H.264)` / `MP4 (H.265 / HEVC)` / `WebM (VP9)` / `MOV` / `アニメGIF（パレット最適化）`
  - 画質優先 (CRF) モード、解像度上限、FPS、音声ビットレート・ミュート、トリミング（開始〜終了時間）
  - 変換前の予想サイズ・ビットレートプレビュー、リアルタイム進捗＆残り時間（ETA）、インラインプレビュー再生、一括キュー処理

---

## 動作環境

以下2つがインストールされ、PATH が通っている必要があります。

- **Node.js** 18 以上
- **FFmpeg**（`ffmpeg` および `ffprobe`）

### クイック導入コマンド

**Windows (winget):**
```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

**macOS (Homebrew):**
```bash
brew install node ffmpeg
```

**Ubuntu / Debian:**
```bash
sudo apt update && sudo apt install -y nodejs ffmpeg
```

---

## インストール & 使い方

```bash
git clone https://github.com/koutyann115/local-video-compressor.git
cd local-video-compressor
```
（または GitHub の **Code → Download ZIP** から展開してすぐ使えます）

### 方法 1: ローカル Web アプリで使う（おすすめ）

- **Windows**: `起動（Webアプリ）.bat` をダブルクリック
- **macOS / Linux / ターミナル**:
  ```bash
  npm run open
  # または
  node server.js --open
  ```

ブラウザが自動で開きます。動画をドラッグ＆ドロップし、目標サイズ（デフォルト **20MB以下**）や形式を選んで **「圧縮・変換をスタート」** を押してください。完了ファイルは `output/` フォルダに保存されます。

### 方法 2: Windows でアイコンにドロップして1秒圧縮

動画ファイルを以下のバッチファイルにドラッグ＆ドロップするだけです（複数ファイル同時ドロップ対応）。

- `20MB以下に圧縮（動画をドロップ）.bat` → 元の動画と同じフォルダに `元ファイル名_20MB.mp4` を作成
- `10MB以下に圧縮（動画をドロップ）.bat` → 元の動画と同じフォルダに `元ファイル名_10MB.mp4` を作成

### 方法 3: CLI から使う

```bash
# デフォルト（20MB以下・MP4 H.264・高精度2パス）
node cli.js input.mp4

# 8MB以下・GPU高速エンコードで複数ファイルを一括圧縮
node cli.js --size 8 --speed gpu video1.mov video2.mkv

# H.265 (HEVC) で 10MB以下に圧縮し、指定フォルダへ出力
node cli.js --size 10 --format hevc --out ./compressed input.mp4
```

#### CLI オプション一覧

| オプション | 短縮 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `--size <MB>` | `-s` | `20` | 目標サイズ (MB) |
| `--format <fmt>` | `-f` | `mp4` | 出力形式 (`mp4` / `hevc` / `webm` / `mov` / `gif`) |
| `--res <px>` | `-r` | `auto` | 解像度上限 (`auto` / `original` / `1080` / `720` / `480` / `360`) |
| `--speed <mode>` | — | `accurate_2pass` | エンコード方式 (`accurate_2pass` / `fast_1pass` / `gpu`) |
| `--out <dir>` | `-o` | 元と同じフォルダ | 出力先ディレクトリ |
| `--mute` | — | オフ | 音声を削除 |

---

## ファイル構成

```text
local-video-compressor/
├── compressor.js                       # FFmpeg 解析・ビットレート計算・2パス/GPU圧縮エンジン
├── server.js                           # ゼロ依存ローカル Web サーバー (SSE / Range配信)
├── cli.js                              # CLI / バッチ用エントリポイント
├── public/
│   └── index.html                      # モダン日本語 Web UI
├── 起動（Webアプリ）.bat                 # Windows ワンクリック起動
├── 20MB以下に圧縮（動画をドロップ）.bat   # Windows D&D 即時圧縮 (20MB)
├── 10MB以下に圧縮（動画をドロップ）.bat   # Windows D&D 即時圧縮 (10MB)
├── package.json
└── LICENSE
```

## 環境変数（任意）

- `PORT`: サーバーポート（デフォルト `3890`、使用中なら自動で空きポートを探索）
- `FFMPEG_PATH` / `FFPROBE_PATH`: PATH 外の `ffmpeg` / `ffprobe` バイナリを明示指定したい場合に使用

---

## License

[MIT](LICENSE)
