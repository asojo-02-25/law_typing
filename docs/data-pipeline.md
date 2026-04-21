# Data Pipeline (Step 1-4)

このドキュメントは、法令データを出題用JSONへ変換する処理フローの詳細です。

## 前提

- Python環境を作成して依存パッケージをインストール済みであること

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Step 1: 法令XMLの取得

スクリプト: `scripts/fetch_law_xml_step1.py`

目的:

- e-Gov API v1 から対象法令候補を取得
- 選定ルールに基づいて法令XMLを保存
- 取得結果をmanifest化

実行:

```powershell
python scripts/fetch_law_xml_step1.py
```

主な引数(省略時はデフォルト):

- `--out-dir` (default: `xml_raw`)
- `--manifest` (default: `xml_raw/fetch_manifest_step1.json`)
- `--timeout` (default: `30`)
- `--retries` (default: `3`)
- `--max-partial-candidates` (default: `10`)

出力:

- `xml_raw/*.xml`
- `xml_raw/fetch_manifest_step1.json`

## Step 2: 本文正規化

スクリプト: `scripts/normalize_law_text_step2.py`

目的:

- Step1で取得したXMLを解析
- タイピング出題向けに段落文を正規化
- 不要データ(短すぎる/長すぎる/参照条文中心など)を除外

実行:

```powershell
python scripts/normalize_law_text_step2.py
```

主な引数:

- `--input-manifest` (default: `xml_raw/fetch_manifest_step1.json`)
- `--output-json` (default: `data/normalized_questions_step2.json`)
- `--output-manifest` (default: `data/normalize_manifest_step2.json`)
- `--min-length` (default: `50`)
- `--max-length` (default: `130`)
- `--reference-filter-mode` (default: `balanced`)

出力:

- `data/normalized_questions_step2.json`
- `data/normalize_manifest_step2.json`

## Step 3: かな変換

スクリプト: `scripts/convert_kana_step3.py`

目的:

- 正規化済みテキストをひらがなへ変換
- SudachiPy + SudachiDict Fullを使用
- カスタム読み辞書(`CUSTOM_READING_MAP`)を優先適用

実行:

```powershell
python scripts/convert_kana_step3.py
```

主な引数:

- `--input-json` (default: `data/normalized_questions_step2.json`)
- `--output-json` (default: `data/questions_step3_kana.json`)
- `--output-manifest` (default: `data/kana_manifest_step3.json`)

出力:

- `data/questions_step3_kana.json`
- `data/kana_manifest_step3.json`

## Step 4: 最終整形・検証

スクリプト: `scripts/finalize_questions_step4.py`

目的:

- 出題データの必須キーを検証
- 重複排除
- かな文字検証(許可外文字の検出)
- フロントエンド読込形式へ変換

実行:

```powershell
python scripts/finalize_questions_step4.py
```

主な引数:

- `--input-json` (default: `data/questions_step3_kana.json`)
- `--output-json` (default: `data/questions.json`)
- `--output-manifest` (default: `data/finalize_manifest_step4.json`)
- `--output-invalid-kana-json` (default: `data/finalize_invalid_kana_step4.json`)

出力:

- `data/questions.json`
- `data/finalize_manifest_step4.json`
- `data/finalize_invalid_kana_step4.json`

## フロントエンドでの利用

- `js/script.js` は `data/questions.json` を優先読込
- 読込失敗時は `js/question.js` にフォールバック

## 注意点

- `xml_raw/` は `.gitignore` に含まれています
- 大きな生データをリポジトリに含めない運用を想定しています
- API仕様変更時はStep1の取得ロジック見直しが必要です
