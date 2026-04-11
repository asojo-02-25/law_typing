import json
import re
from pathlib import Path
from typing import Any


def build_kana_chunks(kana_text: str) -> list[str]:
    if not kana_text:
        return []

    parts = re.split(r"([、。])", kana_text)
    chunks: list[str] = []
    for curr in parts:
        if re.fullmatch(r"[、。]", curr):
            if chunks:
                chunks[-1] += curr
        elif curr != "":
            chunks.append(curr)
    return chunks


def longest_chunk_length(kana_text: str) -> int:
    chunks = build_kana_chunks(kana_text)
    if not chunks:
        return 0
    return max(len(chunk) for chunk in chunks)


def main() -> None:
    output_dir = Path(__file__).resolve().parent
    repo_root = output_dir.parent

    input_path = repo_root / "data" / "questions.json"
    output_path = output_dir / "longChunkQuestionData.json"

    with input_path.open("r", encoding="utf-8") as f:
        payload: dict[str, Any] = json.load(f)

    questions = payload.get("questiondata", [])
    ranked: list[dict[str, Any]] = []

    for idx, question in enumerate(questions):
        text = question.get("text", "")
        kana = question.get("kana", "")
        ranked.append(
            {
                "index": idx,
                "text": text,
                "chunkwordnumber": longest_chunk_length(kana),
            }
        )

    ranked.sort(key=lambda item: (-item["chunkwordnumber"], item["index"]))
    top20 = [
        {
            "text": item["text"],
            "chunkwordnumber": item["chunkwordnumber"],
        }
        for item in ranked[:20]
    ]

    output = {"longChunkQuestionData": top20}

    with output_path.open("w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
