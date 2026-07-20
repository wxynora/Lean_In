from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any


class SubtitleLookupDeadlineExceeded(TimeoutError):
    """Raised before a provider request when the lookup budget has expired."""


@dataclass(frozen=True, slots=True)
class SubtitleLookupPolicy:
    """Provider-neutral network and retry policy for optional subtitle lookup."""

    request_timeout_seconds: float = 15.0
    lookup_timeout_seconds: float = 45.0
    automatic_attempts: int = 1

    def __post_init__(self) -> None:
        if self.request_timeout_seconds <= 0:
            raise ValueError("request_timeout_seconds must be positive")
        if self.lookup_timeout_seconds <= 0:
            raise ValueError("lookup_timeout_seconds must be positive")
        if isinstance(self.automatic_attempts, bool) or self.automatic_attempts < 1:
            raise ValueError("automatic_attempts must be a positive integer")

    def timeout_for_request(self, *, started_at: float, now: float | None = None) -> float:
        current = time.monotonic() if now is None else float(now)
        remaining = float(self.lookup_timeout_seconds) - (current - float(started_at))
        if remaining <= 0:
            raise SubtitleLookupDeadlineExceeded("subtitle lookup budget expired")
        return min(float(self.request_timeout_seconds), remaining)


def deduplicate_subtitle_candidates(
    candidates: Sequence[Mapping[str, Any]],
    *,
    url_field: str = "url",
) -> tuple[Mapping[str, Any], ...]:
    """Preserve provider order while removing blank and duplicate download URLs."""

    unique: list[Mapping[str, Any]] = []
    seen_urls: set[str] = set()
    for candidate in candidates:
        url = str(candidate.get(url_field) or "").strip()
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        unique.append(candidate)
    return tuple(unique)
