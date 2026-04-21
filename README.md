# law_typing (law_type)

司法試験受験生向けのタイピング練習サイトです。主要7科目の法令文を題材に、速度(keys/秒)・正タイプ率・苦手キーを可視化しながら、実戦的な入力精度を鍛えることを目的としています。

就活向けポートフォリオとしては、次の2点を主軸にしています。

1. フロントエンド: ローマ字入力の曖昧性(例: 「ん」の `n` / `nn`)を扱う入力エンジン
2. データ処理: e-Gov APIから取得した法令XMLを、出題用JSONへ変換する4段階パイプライン

## デモ

- 公開URL: 準備中 (GitHub Pagesで公開予定)
- ローカル確認: 下記「クイックスタート」を参照

## 主な機能

- 主要7科目に対応(憲法、民法、商法、民事訴訟法、行政法、刑法、刑事訴訟法)
- 問題数と分野を選択してプレイ可能
- 次に打つべきキーをハイライト表示
- `keys/秒`、正タイプ率、ミスタイプキーを記録
- 履歴グラフ(Chart.js)と期間別表示
- 外れ値(低速・低正答)を履歴集計から自動除外
- プレイデータはLocalStorage保存(サーバー送信なし)

## 技術スタック

- Frontend: HTML / CSS / JavaScript (ES Modules)
- Visualization: Chart.js
- Backend scripts: Python
- NLP: SudachiPy + SudachiDict Full
- Data source: e-Gov法令API v1

## アーキテクチャ概要

```text
e-Gov API
	-> Step1: XML取得 (scripts/fetch_law_xml_step1.py)
	-> Step2: 本文正規化 (scripts/normalize_law_text_step2.py)
	-> Step3: かな変換 (scripts/convert_kana_step3.py)
	-> Step4: 最終整形/検証 (scripts/finalize_questions_step4.py)
	-> data/questions.json
	-> Web app (js/script.js)
```

## クイックスタート

### 1. リポジトリ取得

```powershell
git clone <your-repo-url>
cd law_type
```

### 2. サイトをローカル起動

```powershell
python -m http.server 8000
```

ブラウザで `http://localhost:8000` を開くと、`index.html` から利用できます。

## データ生成パイプライン(概要)

READMEでは概要のみ記載しています。詳細手順・出力仕様は以下を参照してください。

- [docs/data-pipeline.md](docs/data-pipeline.md)

最低限の実行コマンド:

```powershell
python scripts/fetch_law_xml_step1.py
python scripts/normalize_law_text_step2.py
python scripts/convert_kana_step3.py
python scripts/finalize_questions_step4.py
```

## 開発環境セットアップ(Python)

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

`requirements.txt`:

- `sudachipy`
- `sudachidict_full`

## ディレクトリ構成

```text
law_type/
	index.html
	css/
	js/
		script.js
		romajiDictionary.js
	scripts/
		fetch_law_xml_step1.py
		normalize_law_text_step2.py
		convert_kana_step3.py
		finalize_questions_step4.py
	data/
		questions.json
		*_manifest_*.json
	xml_raw/                 # .gitignoreで除外
	docs/
		data-pipeline.md
```

## 実装の見どころ

1. 問題データの安全な読込
	 - `data/questions.json` を優先読込し、失敗時は `js/question.js` にフォールバック
2. ローマ字入力の曖昧性解決
	 - かなユニットごとに候補集合を持ち、入力ごとに候補を絞り込み
	 - `ん` の `n` / `nn` 競合時は保留状態(`pending`)を経て確定
3. 結果データの品質管理
	 - `keys/秒 >= 2` かつ `正タイプ率 >= 70` を満たす記録のみ履歴統計に採用
4. 最終データの文字検証
	 - Step4でかな文字種を検証し、許可外文字を別JSONへ出力

## データと外部ライブラリについて

- 法令データ取得元: e-Gov法令API v1 (`https://laws.e-gov.go.jp/api/1`)
- 画面表示ライブラリ: Chart.js
- リセットCSS: ress
- 個人データ取り扱い: サーバー送信せず、ブラウザLocalStorageに保存

プライバシーポリシー/利用規約:

- [policy.html](policy.html)
- [rule.html](rule.html)

## ライセンス

ライセンスは現在選定中です。確定後に `LICENSE` ファイルを追加し、本節を更新します。

## 公開前チェックリスト

- [ ] デモURLをREADMEに追記
- [ ] ライセンス確定(MIT/Apache-2.0等)
- [ ] e-Gov API利用条件と出典表記の最終確認
- [ ] README手順でクリーン環境起動を再検証

## 今後の改善

- デモ環境公開(GitHub Pages)
- スクリーンショット/GIF追加
- データ生成詳細ドキュメントの拡充
- テスト自動化(パイプライン検証・入力ロジック回帰チェック)

