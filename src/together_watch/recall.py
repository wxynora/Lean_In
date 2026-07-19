from __future__ import annotations

import re
from collections import Counter
from math import log
from typing import Sequence

from .models import PlotChunk


_BM25_K1 = 1.2
_BM25_B = 0.75
_MESSAGE_WEIGHTS = (0.2, 0.45, 1.0)
_LATIN_OR_NUMBER_RE = re.compile(r"[a-z0-9]+", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u3400-\u9fff]+")
_STOPWORDS = {
    "一个",
    "不是",
    "什么",
    "他们",
    "你们",
    "我们",
    "怎么",
    "这个",
    "这里",
    "那个",
    "那里",
    "还是",
    "就是",
    "然后",
    "现在",
    "刚才",
    "有点",
    "about",
    "and",
    "are",
    "for",
    "that",
    "the",
    "this",
    "was",
    "what",
}


def _terms(text: str) -> Counter[str]:
    normalized = str(text or "").lower()
    terms: list[str] = _LATIN_OR_NUMBER_RE.findall(normalized)
    for run in _CJK_RE.findall(normalized):
        if len(run) <= 8 and run not in _STOPWORDS:
            terms.append(run)
        for size in (2, 3):
            for index in range(max(0, len(run) - size + 1)):
                token = run[index : index + size]
                if token not in _STOPWORDS:
                    terms.append(token)
    return Counter(term for term in terms if term and term not in _STOPWORDS)


def _weighted_query_terms(queries: str | Sequence[str]) -> dict[str, float]:
    texts = [queries] if isinstance(queries, str) else [str(item or "") for item in queries]
    texts = [text for text in texts[-3:] if text.strip()]
    weights = _MESSAGE_WEIGHTS[-len(texts) :]
    weighted: dict[str, float] = {}
    for text, weight in zip(texts, weights):
        for term, count in _terms(text).items():
            weighted[term] = weighted.get(term, 0.0) + weight * min(3, count)
    return weighted


def _chunk_terms(chunk: PlotChunk) -> tuple[Counter[str], Counter[str], Counter[str]]:
    body = f"{chunk.summary} {chunk.dialogue_summary}"
    return (
        _terms(body),
        _terms(" ".join(chunk.tags)),
        _terms(" ".join(chunk.characters)),
    )


def _bm25_tf(term_frequency: int, document_length: int, average_length: float) -> float:
    if term_frequency <= 0:
        return 0.0
    length_ratio = document_length / max(1.0, average_length)
    denominator = term_frequency + _BM25_K1 * (1.0 - _BM25_B + _BM25_B * length_ratio)
    return term_frequency * (_BM25_K1 + 1.0) / denominator


class Bm25PlotRecall:
    def __init__(self, *, limit: int = 4) -> None:
        if limit <= 0:
            raise ValueError("limit must be greater than zero")
        self.limit = limit

    def recall(
        self,
        queries: str | Sequence[str],
        chunks: Sequence[PlotChunk],
        *,
        excluded_ids: set[str] | None = None,
    ) -> tuple[PlotChunk, ...]:
        query_terms = _weighted_query_terms(queries)
        if not query_terms:
            return ()

        excluded_ids = excluded_ids or set()
        documents: list[
            tuple[PlotChunk, Counter[str], Counter[str], Counter[str]]
        ] = []
        document_frequency: Counter[str] = Counter()
        character_terms: set[str] = set()
        for chunk in chunks:
            if chunk.chunk_id in excluded_ids:
                continue
            body_terms, tag_terms, chunk_character_terms = _chunk_terms(chunk)
            all_terms = set(body_terms) | set(tag_terms) | set(chunk_character_terms)
            if not all_terms:
                continue
            document_frequency.update(all_terms)
            character_terms.update(chunk_character_terms)
            documents.append((chunk, body_terms, tag_terms, chunk_character_terms))
        if not documents:
            return ()

        average_body_length = sum(
            sum(body.values()) for _, body, _, _ in documents
        ) / len(documents)
        document_count = len(documents)
        scored: list[tuple[float, int, bool, PlotChunk]] = []
        for chunk, body_terms, tag_terms, chunk_character_terms in documents:
            score = 0.0
            has_content_anchor = False
            body_length = sum(body_terms.values())
            for term, query_weight in query_terms.items():
                body_tf = body_terms.get(term, 0)
                tag_tf = tag_terms.get(term, 0)
                character_tf = chunk_character_terms.get(term, 0)
                if not (body_tf or tag_tf or character_tf):
                    continue
                frequency = document_frequency.get(term, 0)
                inverse_frequency = log(
                    1.0 + (document_count - frequency + 0.5) / (frequency + 0.5)
                )
                field_score = (
                    _bm25_tf(body_tf, body_length, average_body_length)
                    + 0.55 * min(1, tag_tf)
                    + 0.12 * min(1, character_tf)
                )
                score += query_weight * inverse_frequency * field_score
                if term not in character_terms and (body_tf or tag_tf):
                    has_content_anchor = True
            if score <= 0:
                continue
            if not has_content_anchor:
                score *= 0.2
            scored.append((score, chunk.end_ms, has_content_anchor, chunk))
        if not scored:
            return ()

        anchored = [item for item in scored if item[2]]
        candidates = anchored if anchored else scored
        candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
        if anchored:
            minimum_score = candidates[0][0] * 0.35
            candidates = [item for item in candidates if item[0] >= minimum_score]
            limit = self.limit
        else:
            limit = 1
        return tuple(item[3] for item in candidates[:limit])
