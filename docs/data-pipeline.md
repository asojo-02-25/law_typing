# Data Pipeline (Step 1-4)

このドキュメントは、法令データを出題用JSONへ変換する処理フローの詳細である。

## 前提

- Python環境を作成して依存パッケージをインストール済みであること。

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
- 旧仮名の促音表記(例: あつた/によつて)を安全な辞書方式で現代表記へ正規化
- 未対応の旧仮名候補を自動抽出し、manifestに集計
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
- `--fail-on-unknown-sokuon` (default: `False`)

出力:

- `data/normalized_questions_step2.json`
- `data/normalize_manifest_step2.json`

備考:

- `normalize_manifest_step2.json` の `sokuon_modernization` に、既対応置換件数と未対応候補の集計が出力される

## Step 3: かな変換

スクリプト: `scripts/convert_kana_step3.py`

目的:

- 正規化済みテキストをひらがなへ変換
- SudachiPy + SudachiDict Fullを使用
- カスタム読み辞書(`CUSTOM_READING_MAP`)を優先適用
- 変換後 `text` に旧仮名候補が残っていないかを検知し、manifestに集計

実行:

```powershell
python scripts/convert_kana_step3.py
```

主な引数:

- `--input-json` (default: `data/normalized_questions_step2.json`)
- `--output-json` (default: `data/questions_step3_kana.json`)
- `--output-manifest` (default: `data/kana_manifest_step3.json`)
- `--fail-on-unknown-sokuon` (default: `False`)

出力:

- `data/questions_step3_kana.json`
- `data/kana_manifest_step3.json`

## Step 4: 最終整形・検証

スクリプト: `scripts/finalize_questions_step4.py`

目的:

- 出題データの必須キーを検証
- 重複排除
- かな文字検証(許可外文字の検出)
- 未対応の旧仮名候補を最終監査し、レポートJSONを出力
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
- `--output-unknown-sokuon-json` (default: `data/finalize_unknown_sokuon_step4.json`)
- `--fail-on-unknown-sokuon` (default: `False`)

出力:

- `data/questions.json`
- `data/finalize_manifest_step4.json`
- `data/finalize_invalid_kana_step4.json`
- `data/finalize_unknown_sokuon_step4.json`

## 厳格モード(任意)

未対応の旧仮名候補を検知した時点で停止したい場合:

```powershell
python scripts/normalize_law_text_step2.py --fail-on-unknown-sokuon
python scripts/convert_kana_step3.py --fail-on-unknown-sokuon
python scripts/finalize_questions_step4.py --fail-on-unknown-sokuon
```

## フロントエンドでの利用

- `js/script.js` は `data/questions.json` を優先読込
- 読込失敗時は `js/question.js` にフォールバック

## 注意点

- `xml_raw/` は `.gitignore` に含まれ、大きな生データをリポジトリに含めない運用を想定。
- API仕様変更時はStep1の取得ロジック見直しが必要。
