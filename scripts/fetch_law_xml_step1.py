#!/usr/bin/env python3
"""Step 1: Fetch major law XML files from e-Gov Law API v1.

This script implements a fixed-target approach with keyword matching.
It fetches law candidates from `/lawlists/1`, narrows them by keyword,
retrieves full XML from `/lawdata/{lawId}`, and applies selection rules:

1. Prefer records whose amendment_type == "1" (if available in XML)
2. Exclude records whose repeal_status indicates repeal (if available)
3. Resolve ties by newest promulgation date
4. If amendment_type is unavailable or no "1" exists, fallback to newest

Note:
- API v1 law list already returns current promulgated laws.
- amendment_type / repeal_status are not always exposed in v1 payloads.
  This script extracts them when present and logs fallback decisions.
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


API_BASE = "https://laws.e-gov.go.jp/api/1"

# 固定リスト（司法試験向けの主要法令）
TARGET_LAWS: Dict[str, List[str]] = {
    "憲法": [
        "日本国憲法",
    ],
    "民法": [
        "民法",
    ],
    "商法": [
        "商法",
        "会社法",
        "手形法",
        "小切手法",
        "保険法",
    ],
    "民事訴訟法": [
        "民事訴訟法",
        "民事執行法",
        "民事保全法",
    ],
    "行政法": [
        "行政手続法",
        "行政不服審査法",
        "行政事件訴訟法",
        "国家賠償法",
        "地方自治法",
    ],
    "刑法": [
        "刑法",
    ],
    "刑事訴訟法": [
        "刑事訴訟法",
    ],
}

FIELD_SLUG = {
    "憲法": "constitutional",
    "民法": "civil",
    "商法": "commercial",
    "民事訴訟法": "civil_procedure",
    "行政法": "administrative",
    "刑法": "criminal",
    "刑事訴訟法": "criminal_procedure",
}

REPEAL_WORDS = {
    "repeal",
    "repealed",
    "abolished",
    "inactive",
    "廃止",
    "失効",
}

AMENDMENT_NAMES = {
    "amendment_type",
    "amendmenttype",
}

REPEAL_NAMES = {
    "repeal_status",
    "repealstatus",
}


@dataclass(frozen=True)
class LawListEntry:
    law_id: str
    law_name: str
    law_no: str
    promulgation_date: str

    def promulgation_key(self) -> int:
        if self.promulgation_date and self.promulgation_date.isdigit() and len(self.promulgation_date) == 8:
            return int(self.promulgation_date)
        return 0


@dataclass
class LawDataDetail:
    entry: LawListEntry
    response_xml: str
    amendment_type: Optional[str]
    repeal_status: Optional[str]
    source_url: str


def local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def normalize_name(raw: str) -> str:
    return local_name(raw).replace("-", "_").strip().lower()


def direct_child(parent: ET.Element, name: str) -> Optional[ET.Element]:
    for child in list(parent):
        if local_name(child.tag) == name:
            return child
    return None


def direct_child_text(parent: ET.Element, name: str) -> str:
    child = direct_child(parent, name)
    if child is None or child.text is None:
        return ""
    return child.text.strip()


def first_text_by_names(root: ET.Element, names: Iterable[str]) -> Optional[str]:
    target = {normalize_name(name) for name in names}
    for elem in root.iter():
        if normalize_name(elem.tag) in target:
            text = (elem.text or "").strip()
            if text:
                return text
    return None


def first_attr_by_names(root: ET.Element, names: Iterable[str]) -> Optional[str]:
    target = {normalize_name(name) for name in names}
    for elem in root.iter():
        for key, value in elem.attrib.items():
            if normalize_name(key) in target:
                stripped = value.strip()
                if stripped:
                    return stripped
    return None


def is_repealed(repeal_status: Optional[str]) -> bool:
    if not repeal_status:
        return False
    normalized = repeal_status.strip().lower()
    return normalized in REPEAL_WORDS


def parse_xml(xml_text: str) -> ET.Element:
    try:
        return ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise RuntimeError(f"XML parse error: {exc}") from exc


def ensure_api_success(root: ET.Element, context: str) -> None:
    result = direct_child(root, "Result")
    if result is None:
        raise RuntimeError(f"{context}: <Result> not found")
    code = direct_child_text(result, "Code")
    message = direct_child_text(result, "Message")
    if code != "0":
        raise RuntimeError(f"{context}: API returned code={code}, message={message or '(empty)'}")


def get_appl_data(root: ET.Element, context: str) -> ET.Element:
    appl_data = direct_child(root, "ApplData")
    if appl_data is None:
        raise RuntimeError(f"{context}: <ApplData> not found")
    return appl_data


def fetch_text(
    url: str,
    timeout: int,
    retries: int,
    user_agent: str,
    allow_insecure_ssl: bool,
) -> str:
    headers = {"User-Agent": user_agent}
    last_error: Optional[Exception] = None

    for attempt in range(1, retries + 1):
        try:
            request = urllib.request.Request(url, headers=headers)
            context = ssl.create_default_context()
            with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
                payload = response.read()
            return payload.decode("utf-8")
        except ssl.SSLCertVerificationError as exc:
            if not allow_insecure_ssl:
                raise RuntimeError(
                    "SSL証明書検証に失敗しました。必要であれば --allow-insecure-ssl を指定してください。"
                ) from exc
            request = urllib.request.Request(url, headers=headers)
            insecure = ssl._create_unverified_context()
            with urllib.request.urlopen(request, timeout=timeout, context=insecure) as response:
                payload = response.read()
            return payload.decode("utf-8")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt == retries:
                break
            time.sleep(0.7 * attempt)

    raise RuntimeError(f"Request failed after {retries} attempts: {url} ({last_error})")


def fetch_law_list(args: argparse.Namespace) -> List[LawListEntry]:
    url = f"{API_BASE}/lawlists/1"
    xml_text = fetch_text(
        url=url,
        timeout=args.timeout,
        retries=args.retries,
        user_agent=args.user_agent,
        allow_insecure_ssl=args.allow_insecure_ssl,
    )
    root = parse_xml(xml_text)
    ensure_api_success(root, "lawlists")
    appl_data = get_appl_data(root, "lawlists")

    entries: List[LawListEntry] = []
    for child in list(appl_data):
        if local_name(child.tag) != "LawNameListInfo":
            continue
        law_id = direct_child_text(child, "LawId")
        law_name = direct_child_text(child, "LawName")
        law_no = direct_child_text(child, "LawNo")
        promulgation_date = direct_child_text(child, "PromulgationDate")
        if not law_id or not law_name:
            continue
        entries.append(
            LawListEntry(
                law_id=law_id,
                law_name=law_name,
                law_no=law_no,
                promulgation_date=promulgation_date,
            )
        )

    if not entries:
        raise RuntimeError("lawlists: no law entries found")
    return entries


def keyword_score(law_name: str, keyword: str) -> int:
    if law_name == keyword:
        return 1000
    score = 0
    if law_name.startswith(keyword):
        score += 300
    elif keyword in law_name:
        score += 200

    # 施行令・施行規則などは本体法より優先度を下げる
    noise_tokens = (
        "施行令",
        "施行規則",
        "施行法",
        "一部を改正する",
    )
    if any(token in law_name for token in noise_tokens):
        score -= 120
    return score


def find_candidates(entries: Sequence[LawListEntry], keyword: str, max_partial: int) -> List[LawListEntry]:
    exact = [entry for entry in entries if entry.law_name == keyword]
    if exact:
        return sorted(exact, key=lambda e: e.promulgation_key(), reverse=True)

    partial = [entry for entry in entries if keyword in entry.law_name]
    partial.sort(key=lambda e: (keyword_score(e.law_name, keyword), e.promulgation_key()), reverse=True)
    return partial[:max_partial]


def extract_status_fields(lawdata_root: ET.Element) -> Tuple[Optional[str], Optional[str]]:
    # name-based extraction from both tags and attributes
    amendment_type = first_text_by_names(lawdata_root, AMENDMENT_NAMES)
    if not amendment_type:
        amendment_type = first_attr_by_names(lawdata_root, AMENDMENT_NAMES)

    repeal_status = first_text_by_names(lawdata_root, REPEAL_NAMES)
    if not repeal_status:
        repeal_status = first_attr_by_names(lawdata_root, REPEAL_NAMES)

    return amendment_type, repeal_status


def fetch_law_data(
    entry: LawListEntry,
    args: argparse.Namespace,
    cache: Dict[str, LawDataDetail],
) -> LawDataDetail:
    if entry.law_id in cache:
        return cache[entry.law_id]

    encoded = urllib.parse.quote(entry.law_id)
    url = f"{API_BASE}/lawdata/{encoded}"
    xml_text = fetch_text(
        url=url,
        timeout=args.timeout,
        retries=args.retries,
        user_agent=args.user_agent,
        allow_insecure_ssl=args.allow_insecure_ssl,
    )
    root = parse_xml(xml_text)
    ensure_api_success(root, f"lawdata:{entry.law_id}")
    amendment_type, repeal_status = extract_status_fields(root)

    detail = LawDataDetail(
        entry=entry,
        response_xml=xml_text,
        amendment_type=amendment_type,
        repeal_status=repeal_status,
        source_url=url,
    )
    cache[entry.law_id] = detail
    return detail


def select_best(details: Sequence[LawDataDetail]) -> Tuple[Optional[LawDataDetail], str]:
    if not details:
        return None, "no_candidates"

    non_repealed = [detail for detail in details if not is_repealed(detail.repeal_status)]
    if not non_repealed:
        return None, "all_candidates_repealed"

    amendment_pool = [detail for detail in non_repealed if (detail.amendment_type or "").strip() == "1"]
    if amendment_pool:
        selected = max(amendment_pool, key=lambda d: d.entry.promulgation_key())
        return selected, "amendment_type=1_and_latest_promulgation"

    selected = max(non_repealed, key=lambda d: d.entry.promulgation_key())
    return selected, "fallback_latest_promulgation_no_amendment_type_1"


def sanitize_keyword(keyword: str) -> str:
    safe = re.sub(r"[^0-9a-zA-Z]+", "_", keyword).strip("_")
    return safe.lower() or "keyword"


def build_output_name(field: str, keyword: str, law_id: str) -> str:
    field_slug = FIELD_SLUG.get(field, "field")
    keyword_slug = sanitize_keyword(keyword)
    return f"{field_slug}_{keyword_slug}_{law_id}.xml"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch law XML files for typing source generation (Step 1)")
    parser.add_argument("--out-dir", default="xml_raw", help="Output directory for fetched XML files")
    parser.add_argument(
        "--manifest",
        default="xml_raw/fetch_manifest_step1.json",
        help="Output JSON manifest path",
    )
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout seconds")
    parser.add_argument("--retries", type=int, default=3, help="HTTP retries")
    parser.add_argument(
        "--max-partial-candidates",
        type=int,
        default=10,
        help="Max candidate count when exact match is unavailable",
    )
    parser.add_argument(
        "--user-agent",
        default="law-type-step1-fetcher/1.0",
        help="HTTP User-Agent",
    )
    parser.add_argument(
        "--allow-insecure-ssl",
        action="store_true",
        help="Allow insecure SSL when certificate verification fails",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    workspace = Path(__file__).resolve().parent.parent
    out_dir = (workspace / args.out_dir).resolve()
    manifest_path = (workspace / args.manifest).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    entries = fetch_law_list(args)
    cache: Dict[str, LawDataDetail] = {}

    records: List[Dict[str, object]] = []
    field_counts: Dict[str, int] = {field: 0 for field in TARGET_LAWS}
    selected_total = 0

    for field, keywords in TARGET_LAWS.items():
        selected_in_field: set[str] = set()
        for keyword in keywords:
            candidates = find_candidates(entries, keyword, args.max_partial_candidates)
            details: List[LawDataDetail] = []
            for candidate in candidates:
                detail = fetch_law_data(candidate, args, cache)
                details.append(detail)

            selected, reason = select_best(details)
            if selected is None:
                records.append(
                    {
                        "field": field,
                        "keyword": keyword,
                        "candidate_count": len(candidates),
                        "selected": False,
                        "selection_reason": reason,
                    }
                )
                continue

            if selected.entry.law_id in selected_in_field:
                records.append(
                    {
                        "field": field,
                        "keyword": keyword,
                        "candidate_count": len(candidates),
                        "selected": False,
                        "selection_reason": "duplicate_law_id_in_field",
                        "law_id": selected.entry.law_id,
                        "law_name": selected.entry.law_name,
                    }
                )
                continue

            selected_in_field.add(selected.entry.law_id)

            file_name = build_output_name(field, keyword, selected.entry.law_id)
            output_file = out_dir / file_name
            output_file.write_text(selected.response_xml, encoding="utf-8")

            selected_total += 1
            field_counts[field] += 1

            records.append(
                {
                    "field": field,
                    "keyword": keyword,
                    "candidate_count": len(candidates),
                    "selected": True,
                    "selection_reason": reason,
                    "law_id": selected.entry.law_id,
                    "law_name": selected.entry.law_name,
                    "law_no": selected.entry.law_no,
                    "promulgation_date": selected.entry.promulgation_date,
                    "amendment_type": selected.amendment_type,
                    "repeal_status": selected.repeal_status,
                    "source_url": selected.source_url,
                    "output_file": str(output_file.relative_to(workspace)).replace("\\", "/"),
                }
            )

    summary = {
        "selected_total": selected_total,
        "field_counts": field_counts,
        "record_total": len(records),
        "amendment_type_available_count": sum(1 for rec in records if rec.get("amendment_type")),
        "repeal_status_available_count": sum(1 for rec in records if rec.get("repeal_status")),
    }

    manifest = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "api_base": API_BASE,
        "selection_policy": {
            "prefer_amendment_type": "1",
            "exclude_repeal_status": "Repeal",
            "fallback": "latest_promulgation",
            "keyword_search": "fixed_list_contains_match_with_exact_priority",
        },
        "summary": summary,
        "records": records,
    }

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=== Step 1 fetch summary ===")
    print(f"Output directory : {out_dir}")
    print(f"Manifest file    : {manifest_path}")
    print(f"Selected XML     : {selected_total}")
    for field, count in field_counts.items():
        print(f"- {field}: {count}")

    if selected_total == 0:
        print("ERROR: no law XML selected.", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
