#!/usr/bin/env python3
"""Step 3: Convert normalized law text to hiragana problem data.

Input:
- data/normalized_questions_step2.json

Output:
- data/questions_step3_kana.json
- data/kana_manifest_step3.json

Rules:
1. Normalize source text with NFKC before conversion
2. Apply custom reading map priority before kana conversion
3. Convert to hiragana with SudachiPy + SudachiDict Full
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple

from sokuon_normalization import (
    HISTORICAL_SOKUON_CANDIDATE_RE,
    SOKUON_MODERNIZE_MAP,
    detect_historical_sokuon_candidates,
)

try:
    from sudachipy import Dictionary, SplitMode
except ImportError as exc:
    raise SystemExit(
        "SudachiPy and SudachiDict Full are required. Install with: pip install sudachipy sudachidict_full"
    ) from exc


CUSTOM_READING_MAP: Dict[str, str] = {
    "遺言": "いごん",
    "競売": "けいばい",
    "瑕疵": "かし",
    "勾留": "こうりゅう",
    "譲受会社": "ゆずりうけがいしゃ",
    "前二項": "ぜんにこう",
    "前三項": "ぜんさんこう",
    "前各項": "ぜんかくこう",
    "身体": "しんたい",
    "居所": "きょしょ",
    "証拠物": "しょうこぶつ",
    "原判決": "げんはんけつ",
    "原裁判所": "げんさいばんしょ",
    "申立人": "もうしたてにん",
    "永小作権": "えいこさくけん",
    "永小作人": "えいこさくにん",
    "二十日": "にじゅうにち",
    "三十日":"さんじゅうにち",
    "四十日":"よんじゅうにち",
    "五十日":"ごじゅうにち",
    "六十日":"ろくじゅうにち",
    "七十日":"ななじゅうにち",
    "八十日":"はちじゅうにち",
    "九十日":"きゅうじゅうにち",
    "原裁決": "げんさいけつ",
    "原裁判": "げんさいばん",
    "一週間": "いっしゅうかん",
    "後一週間": "のちいっしゅうかん",
    "期間又": "きかんまた",
    "商人間又": "しょうにんかんまた",
    "間又": "あいだまた",
    "取引所": "とりひきじょ",
    "浸害": "しんがい",
    "荷送人": "におくりにん",
    "招状": "しょうじょう",
    "併存的債務引受": "へいぞんてきさいむひきうけ",
    "若しくは": "もしくは",
    "何人": "なんぴと",
    "第一項": "だいいっこう",
    "日本": "にほん",
    "月以内": "さんげついない",
    "月以上": "さんげついじょう",
    "月を経過": "さんげつをけいか",
    "予約権付社債": "よやくけんつきしゃさい",
    "設置会社": "せっちがいしゃ",
    "持分会社": "もちぶんがいしゃ",
    "当該会社": "とうがいがいしゃ",
    "対象会社": "たいしょうがいしゃ",
    "消滅会社": "しょうめつがいしゃ",
    "外国会社": "がいこくがいしゃ",
    "譲渡会社": "じょうとがいしゃ",
    "公開会社": "こうかいがいしゃ",
    "分割会社": "ぶんかつがいしゃ",
}

CUSTOM_READING_TERMS: Tuple[str, ...] = tuple(sorted(CUSTOM_READING_MAP.keys(), key=len, reverse=True))
CUSTOM_READING_PATTERN = (
    re.compile("(" + "|".join(re.escape(term) for term in CUSTOM_READING_TERMS) + ")")
    if CUSTOM_READING_TERMS
    else None
)
SUDACHI_DICT_TYPE = "full"
SUDACHI_SPLIT_MODE = SplitMode.C
SUDACHI_SPLIT_MODE_NAME = "C"


def ensure_terminal_period(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        return stripped
    if stripped.endswith("。"):
        return stripped
    return f"{stripped}。"


def normalize_nfkc(text: str) -> str:
    return unicodedata.normalize("NFKC", text)


def katakana_to_hiragana(text: str) -> str:
    converted: List[str] = []
    for char in text:
        code = ord(char)
        if 0x30A1 <= code <= 0x30F6:
            converted.append(chr(code - 0x60))
        else:
            converted.append(char)
    return "".join(converted)


def split_with_custom_terms(text: str) -> List[str]:
    if not text:
        return []
    if CUSTOM_READING_PATTERN is None:
        return [text]
    return [part for part in CUSTOM_READING_PATTERN.split(text) if part]


def create_tokenizer() -> Any:
    try:
        return Dictionary(dict=SUDACHI_DICT_TYPE).create()
    except Exception as exc:
        raise SystemExit(
            "SudachiPy dictionary initialization failed. Install with: pip install sudachipy sudachidict_full"
        ) from exc


def convert_segment_to_hiragana(segment: str, tokenizer: Any) -> str:
    if not segment:
        return ""

    converted_tokens: List[str] = []
    for morpheme in tokenizer.tokenize(segment, SUDACHI_SPLIT_MODE):
        surface = morpheme.surface()
        reading = morpheme.reading_form()
        token_text = reading if isinstance(reading, str) and reading and reading != "*" else surface
        converted_tokens.append(katakana_to_hiragana(token_text))

    return "".join(converted_tokens)


def convert_to_hiragana(text: str, tokenizer: Any) -> Tuple[str, Dict[str, int]]:
    normalized = normalize_nfkc(text)
    hits: Dict[str, int] = {}
    converted_parts: List[str] = []

    for part in split_with_custom_terms(normalized):
        custom = CUSTOM_READING_MAP.get(part)
        if custom is not None:
            converted_parts.append(custom)
            hits[part] = hits.get(part, 0) + 1
            continue
        converted_parts.append(convert_segment_to_hiragana(part, tokenizer))

    kana = "".join(converted_parts)
    kana = normalize_nfkc(kana)
    kana = re.sub(r"\s+", "", kana)

    return kana, hits


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert normalized law text into kana data (Step 3)")
    parser.add_argument(
        "--input-json",
        default="data/normalized_questions_step2.json",
        help="Step 2 normalized input JSON",
    )
    parser.add_argument(
        "--output-json",
        default="data/questions_step3_kana.json",
        help="Step 3 kana output JSON",
    )
    parser.add_argument(
        "--output-manifest",
        default="data/kana_manifest_step3.json",
        help="Step 3 summary manifest JSON",
    )
    parser.add_argument(
        "--fail-on-unknown-sokuon",
        action="store_true",
        help="Exit with code 1 if unresolved historical sokuon candidates are detected",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    workspace = Path(__file__).resolve().parent.parent

    input_json = (workspace / args.input_json).resolve()
    output_json = (workspace / args.output_json).resolve()
    output_manifest = (workspace / args.output_manifest).resolve()

    if not input_json.exists():
        print(f"ERROR: input json not found: {input_json}", file=sys.stderr)
        return 2

    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_manifest.parent.mkdir(parents=True, exist_ok=True)

    try:
        records = json.loads(input_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"ERROR: input json parse error: {exc}", file=sys.stderr)
        return 2

    if not isinstance(records, list):
        print("ERROR: input JSON root must be a list", file=sys.stderr)
        return 2

    converter = create_tokenizer()

    output_records: List[Dict[str, str]] = []
    custom_hits_total: Dict[str, int] = {key: 0 for key in CUSTOM_READING_MAP.keys()}
    skipped_invalid = 0
    unknown_text_by_term: Dict[str, int] = {}
    unknown_any_record_count = 0
    unknown_text_record_count = 0
    unknown_text_total_occurrences = 0
    unknown_examples: List[Dict[str, object]] = []

    for rec in records:
        if not isinstance(rec, dict):
            skipped_invalid += 1
            continue

        raw_text = str(rec.get("text", "")).strip()
        field = str(rec.get("field", "")).strip()
        source = str(rec.get("source", "")).strip()

        if not raw_text or not field or not source:
            skipped_invalid += 1
            continue

        text = ensure_terminal_period(normalize_nfkc(raw_text))
        kana, hits = convert_to_hiragana(text, converter)
        kana = ensure_terminal_period(kana)

        text_unknown_candidates = detect_historical_sokuon_candidates(text)

        if text_unknown_candidates:
            unknown_any_record_count += 1
            unknown_text_record_count += 1
            unknown_text_total_occurrences += len(text_unknown_candidates)
            for candidate in text_unknown_candidates:
                unknown_text_by_term[candidate] = unknown_text_by_term.get(candidate, 0) + 1

        if text_unknown_candidates and len(unknown_examples) < 20:
            unknown_examples.append(
                {
                    "field": field,
                    "source": source,
                    "text": text,
                    "kana": kana,
                    "text_unknown_patterns": sorted(set(text_unknown_candidates)),
                }
            )

        for term, count in hits.items():
            custom_hits_total[term] = custom_hits_total.get(term, 0) + count

        output_records.append(
            {
                "text": text,
                "kana": kana,
                "field": field,
                "source": source,
            }
        )

    output_json.write_text(json.dumps(output_records, ensure_ascii=False, indent=2), encoding="utf-8")

    sorted_unknown_text_by_term = dict(
        sorted(
            unknown_text_by_term.items(),
            key=lambda item: (-item[1], item[0]),
        )
    )

    summary = {
        "input_count": len(records),
        "output_count": len(output_records),
        "skipped_invalid": skipped_invalid,
        "custom_reading_hits_total": sum(custom_hits_total.values()),
        "custom_reading_hits_by_term": custom_hits_total,
    }

    manifest = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "input_json": str(input_json.relative_to(workspace)).replace("\\", "/"),
        "output_json": str(output_json.relative_to(workspace)).replace("\\", "/"),
        "rules": {
            "normalize_nfkc": True,
            "custom_reading_map": CUSTOM_READING_MAP,
            "converter": "sudachipy",
            "dictionary": "sudachidict_full",
            "split_mode": SUDACHI_SPLIT_MODE_NAME,
            "custom_reading_strategy": "term-priority-segmentation",
            "sokuon_unknown_detection": {
                "enabled": True,
                "candidate_regex": HISTORICAL_SOKUON_CANDIDATE_RE.pattern,
                "known_map_size": len(SOKUON_MODERNIZE_MAP),
            },
        },
        "sokuon_detection": {
            "unknown_any_record_count": unknown_any_record_count,
            "unknown_text_record_count": unknown_text_record_count,
            "unknown_text_total_occurrences": unknown_text_total_occurrences,
            "unknown_text_by_term": sorted_unknown_text_by_term,
            "unknown_examples": unknown_examples,
        },
        "summary": summary,
    }

    output_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=== Step 3 kana conversion summary ===")
    print(f"Input json      : {input_json}")
    print(f"Output json     : {output_json}")
    print(f"Output manifest : {output_manifest}")
    print(f"Input count     : {len(records)}")
    print(f"Output count    : {len(output_records)}")
    print(f"Skipped invalid : {skipped_invalid}")
    print(f"Unknown sokuon records (text): {unknown_text_record_count}")
    print("Custom reading hits:")
    for term, count in custom_hits_total.items():
        print(f"- {term}: {count}")

    if not output_records:
        print("ERROR: no output records", file=sys.stderr)
        return 2

    if args.fail_on_unknown_sokuon and unknown_any_record_count > 0:
        print(
            "ERROR: unresolved historical sokuon candidates detected. "
            "Check data/kana_manifest_step3.json.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
