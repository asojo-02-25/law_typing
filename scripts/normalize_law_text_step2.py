#!/usr/bin/env python3
"""Step 2: Normalize raw law XML into typing-suitable text records.

Input:
- Step 1 manifest JSON (default: xml_raw/fetch_manifest_step1.json)
- XML files listed in the manifest

Output:
- data/normalized_questions_step2.json
- data/normalize_manifest_step2.json

Filtering/normalization rules:
1. Paragraph-level extraction from MainProvision/Article/Paragraph
2. Skip an Article if it contains Item tag
3. Normalize with NFKC
4. Remove bracketed segments and residual brackets
5. Exclude text containing "号"
6. Exclude cross-reference-heavy text by mode
7. Keep length in [50, 130]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


OPEN_TO_CLOSE = {
    "(": ")",
    "（": "）",
    "[": "]",
    "［": "］",
    "{": "}",
    "｛": "｝",
    "「": "」",
    "『": "』",
    "〈": "〉",
    "《": "》",
    "【": "】",
}

BRACKET_CHARS = "()（）[]［］{}｛｝「」『』〈〉《》【】"
IGNORED_TEXT_TAGS = {"Rt"}
REFERENCE_FILTER_MODES = ("none", "conservative", "balanced", "strict")
KANJI_NUMBER_CHARS = "0-9一二三四五六七八九十百千〇零"

PRIMARY_CROSS_REFERENCE_TERMS = (
    "前項",
    "次項",
    "前条",
    "次条",
    "同項",
    "同条",
    "前号",
    "次号",
    "同号",
    "本項",
    "本条",
    "本号",
)

SECONDARY_CROSS_REFERENCE_TERMS = (
    "準用",
    "例による",
    "定めるところにより",
    "読み替えて適用",
)

CONTEXTUAL_CROSS_REFERENCE_TERMS = (
    "規定",
    "当該",
    "この法律",
    "この条",
    "この項",
)

ARTICLE_REFERENCE_RE = re.compile(
    rf"第[{KANJI_NUMBER_CHARS}]+条(?:の[{KANJI_NUMBER_CHARS}]+)?(?:第[{KANJI_NUMBER_CHARS}]+項)?"
)


@dataclass(frozen=True)
class Step1Record:
    field: str
    law_id: str
    law_name: str
    output_file: str


def local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def direct_child(parent: ET.Element, name: str) -> Optional[ET.Element]:
    for child in list(parent):
        if local_name(child.tag) == name:
            return child
    return None


def direct_children(parent: ET.Element, name: str) -> List[ET.Element]:
    children: List[ET.Element] = []
    for child in list(parent):
        if local_name(child.tag) == name:
            children.append(child)
    return children


def full_text(elem: Optional[ET.Element]) -> str:
    if elem is None:
        return ""
    return "".join(elem.itertext()).strip()


def collect_text_excluding_tags(elem: ET.Element, ignored_tags: set[str]) -> str:
    """Collect text recursively while ignoring text under specific tags (e.g. ruby readings)."""
    chunks: List[str] = []
    name = local_name(elem.tag)

    if name not in ignored_tags and elem.text:
        chunks.append(elem.text)

    for child in list(elem):
        chunks.append(collect_text_excluding_tags(child, ignored_tags))
        if child.tail:
            chunks.append(child.tail)

    return "".join(chunks)


def remove_bracket_contents(text: str) -> str:
    updated = text
    for _ in range(16):
        changed = False
        for open_br, close_br in OPEN_TO_CLOSE.items():
            pattern = re.escape(open_br) + r"[^" + re.escape(open_br + close_br) + r"]*" + re.escape(close_br)
            next_text = re.sub(pattern, "", updated)
            if next_text != updated:
                changed = True
                updated = next_text
        if not changed:
            break
    return updated


def normalize_text(raw: str) -> str:
    text = unicodedata.normalize("NFKC", raw)
    text = remove_bracket_contents(text)
    text = re.sub("[" + re.escape(BRACKET_CHARS) + "]", "", text)
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[、。]{2,}", lambda m: m.group(0)[0], text)
    text = text.strip("、。")
    return text


def has_item_descendant(article: ET.Element) -> bool:
    for node in article.iter():
        if local_name(node.tag) == "Item":
            return True
    return False


def classify_cross_reference(text: str, mode: str) -> Optional[str]:
    if mode == "none":
        return None

    has_primary_term = any(term in text for term in PRIMARY_CROSS_REFERENCE_TERMS)
    has_article_reference = ARTICLE_REFERENCE_RE.search(text) is not None
    if has_primary_term or has_article_reference:
        return "primary"

    has_secondary_term = any(term in text for term in SECONDARY_CROSS_REFERENCE_TERMS)
    if mode in {"balanced", "strict"} and has_secondary_term:
        return "secondary"

    if mode != "strict":
        return None

    has_contextual_term = any(term in text for term in CONTEXTUAL_CROSS_REFERENCE_TERMS)
    if not has_contextual_term:
        return None

    # Avoid broad false positives by requiring a contextual anchor with 規定.
    has_contextual_anchor = any(anchor in text for anchor in ("この法律", "この条", "この項", "当該"))
    if has_contextual_anchor and "規定" in text:
        return "contextual"

    return None


def find_first(node: ET.Element, name: str) -> Optional[ET.Element]:
    for child in node.iter():
        if local_name(child.tag) == name:
            return child
    return None


def get_source_label(law_name: str, article: ET.Element, paragraph: ET.Element) -> str:
    article_title = full_text(direct_child(article, "ArticleTitle"))
    article_num = article.attrib.get("Num", "").strip()
    if not article_title:
        article_title = f"第{article_num}条" if article_num else "条番号不明"

    para_num = paragraph.attrib.get("Num", "").strip()
    para_part = ""
    if para_num:
        para_part = f" 第{para_num}項"
    return f"{law_name} {article_title}{para_part}"


def collect_step1_records(manifest_path: Path) -> List[Step1Record]:
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    records: List[Step1Record] = []

    for rec in data.get("records", []):
        if not rec.get("selected"):
            continue
        output_file = str(rec.get("output_file", "")).strip()
        if not output_file:
            continue
        records.append(
            Step1Record(
                field=str(rec.get("field", "")).strip(),
                law_id=str(rec.get("law_id", "")).strip(),
                law_name=str(rec.get("law_name", "")).strip(),
                output_file=output_file,
            )
        )
    return records


def extract_main_articles(root: ET.Element) -> List[ET.Element]:
    appl_data = direct_child(root, "ApplData")
    if appl_data is None:
        return []
    law_full = direct_child(appl_data, "LawFullText")
    if law_full is None:
        return []
    law = find_first(law_full, "Law")
    if law is None:
        return []
    law_body = direct_child(law, "LawBody")
    if law_body is None:
        return []
    main = direct_child(law_body, "MainProvision")
    if main is None:
        return []

    articles: List[ET.Element] = []
    for elem in main.iter():
        if local_name(elem.tag) == "Article":
            articles.append(elem)
    return articles


def extract_sentences_from_paragraph(paragraph: ET.Element) -> str:
    chunks: List[str] = []
    for elem in paragraph.iter():
        if local_name(elem.tag) == "Sentence":
            sentence_text = collect_text_excluding_tags(elem, IGNORED_TEXT_TAGS).strip()
            if sentence_text:
                chunks.append(sentence_text)
    return "".join(chunks)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Normalize law XML into typing-suitable paragraph data (Step 2)")
    parser.add_argument(
        "--input-manifest",
        default="xml_raw/fetch_manifest_step1.json",
        help="Step 1 manifest JSON path",
    )
    parser.add_argument(
        "--output-json",
        default="data/normalized_questions_step2.json",
        help="Output JSON path for normalized records",
    )
    parser.add_argument(
        "--output-manifest",
        default="data/normalize_manifest_step2.json",
        help="Output summary manifest path",
    )
    parser.add_argument("--min-length", type=int, default=50, help="Minimum text length")
    parser.add_argument("--max-length", type=int, default=130, help="Maximum text length")
    parser.add_argument(
        "--reference-filter-mode",
        choices=REFERENCE_FILTER_MODES,
        default="balanced",
        help="Cross-reference filtering strictness",
    )
    return parser.parse_args()


def build_summary_template() -> Dict[str, int]:
    return {
        "articles_total": 0,
        "articles_skipped_item": 0,
        "paragraphs_total": 0,
        "paragraphs_kept": 0,
        "filtered_empty": 0,
        "filtered_has_bracket": 0,
        "filtered_contains_go": 0,
        "filtered_cross_reference": 0,
        "filtered_cross_reference_primary": 0,
        "filtered_cross_reference_secondary": 0,
        "filtered_cross_reference_contextual": 0,
        "filtered_too_short": 0,
        "filtered_too_long": 0,
        "filtered_duplicate": 0,
    }


def main() -> int:
    args = parse_args()

    workspace = Path(__file__).resolve().parent.parent
    input_manifest = (workspace / args.input_manifest).resolve()
    output_json = (workspace / args.output_json).resolve()
    output_manifest = (workspace / args.output_manifest).resolve()

    if not input_manifest.exists():
        print(f"ERROR: input manifest not found: {input_manifest}", file=sys.stderr)
        return 2

    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_manifest.parent.mkdir(parents=True, exist_ok=True)

    step1_records = collect_step1_records(input_manifest)
    if not step1_records:
        print("ERROR: no selected records in Step 1 manifest", file=sys.stderr)
        return 2

    normalized_records: List[Dict[str, str]] = []
    seen = set()
    overall = build_summary_template()
    per_field: Dict[str, Dict[str, int]] = {}

    for rec in step1_records:
        per_field.setdefault(rec.field, build_summary_template())
        xml_path = (workspace / rec.output_file).resolve()
        if not xml_path.exists():
            continue

        root = ET.fromstring(xml_path.read_text(encoding="utf-8"))
        articles = extract_main_articles(root)

        for article in articles:
            overall["articles_total"] += 1
            per_field[rec.field]["articles_total"] += 1

            if has_item_descendant(article):
                overall["articles_skipped_item"] += 1
                per_field[rec.field]["articles_skipped_item"] += 1
                continue

            paragraphs = direct_children(article, "Paragraph")
            for paragraph in paragraphs:
                overall["paragraphs_total"] += 1
                per_field[rec.field]["paragraphs_total"] += 1

                raw_text = extract_sentences_from_paragraph(paragraph)
                text = normalize_text(raw_text)

                if not text:
                    overall["filtered_empty"] += 1
                    per_field[rec.field]["filtered_empty"] += 1
                    continue

                if re.search("[" + re.escape(BRACKET_CHARS) + "]", text):
                    overall["filtered_has_bracket"] += 1
                    per_field[rec.field]["filtered_has_bracket"] += 1
                    continue

                if "号" in text:
                    overall["filtered_contains_go"] += 1
                    per_field[rec.field]["filtered_contains_go"] += 1
                    continue

                cross_ref_class = classify_cross_reference(text, args.reference_filter_mode)
                if cross_ref_class is not None:
                    overall["filtered_cross_reference"] += 1
                    per_field[rec.field]["filtered_cross_reference"] += 1

                    class_key = f"filtered_cross_reference_{cross_ref_class}"
                    overall[class_key] += 1
                    per_field[rec.field][class_key] += 1
                    continue

                text_len = len(text)
                if text_len < args.min_length:
                    overall["filtered_too_short"] += 1
                    per_field[rec.field]["filtered_too_short"] += 1
                    continue
                if text_len > args.max_length:
                    overall["filtered_too_long"] += 1
                    per_field[rec.field]["filtered_too_long"] += 1
                    continue

                source = get_source_label(rec.law_name, article, paragraph)
                dedupe_key = (rec.field, source, text)
                if dedupe_key in seen:
                    overall["filtered_duplicate"] += 1
                    per_field[rec.field]["filtered_duplicate"] += 1
                    continue
                seen.add(dedupe_key)

                normalized_records.append(
                    {
                        "text": text,
                        "field": rec.field,
                        "source": source,
                    }
                )

                overall["paragraphs_kept"] += 1
                per_field[rec.field]["paragraphs_kept"] += 1

    normalized_records.sort(key=lambda r: (r["field"], len(r["text"]), r["source"], r["text"]))
    output_json.write_text(json.dumps(normalized_records, ensure_ascii=False, indent=2), encoding="utf-8")

    manifest = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "input_manifest": str(input_manifest.relative_to(workspace)).replace("\\", "/"),
        "output_json": str(output_json.relative_to(workspace)).replace("\\", "/"),
        "rules": {
            "granularity": "paragraph",
            "skip_article_with_item": True,
            "normalize_nfkc": True,
            "remove_bracket_contents": True,
            "remove_text_contains_go": True,
            "reference_filter_mode": args.reference_filter_mode,
            "reference_filter_terms": {
                "primary": list(PRIMARY_CROSS_REFERENCE_TERMS),
                "secondary": list(SECONDARY_CROSS_REFERENCE_TERMS),
                "contextual": list(CONTEXTUAL_CROSS_REFERENCE_TERMS),
                "article_reference_regex": ARTICLE_REFERENCE_RE.pattern,
            },
            "min_length": args.min_length,
            "max_length": args.max_length,
        },
        "summary": overall,
        "per_field": per_field,
        "output_count": len(normalized_records),
    }
    output_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=== Step 2 normalization summary ===")
    print(f"Input manifest : {input_manifest}")
    print(f"Output json    : {output_json}")
    print(f"Output manifest: {output_manifest}")
    print(f"Kept records   : {len(normalized_records)}")
    for key, value in overall.items():
        print(f"- {key}: {value}")

    if not normalized_records:
        print("ERROR: no records after normalization", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
