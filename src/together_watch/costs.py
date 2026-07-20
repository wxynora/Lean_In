from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Iterable, Mapping


SESSION_COST_PURPOSES = frozenset(
    {"identify", "timeline_prepass", "rolling", "knowledge_card", "subtitle_lookup"}
)
# Compatibility alias for integrations that imported the original name.
ANALYSIS_MODEL_PURPOSES = SESSION_COST_PURPOSES


def _non_negative_int(value: Any) -> int:
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return 0


def _non_negative_float(value: Any) -> float:
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 0.0


def _usage_totals(value: Any) -> dict[str, Any]:
    usage = value if isinstance(value, Mapping) else {}
    model = str(usage.get("model") or "").strip()
    input_tokens = _non_negative_int(usage.get("input_tokens"))
    output_tokens = _non_negative_int(usage.get("output_tokens"))
    total_tokens = _non_negative_int(usage.get("total_tokens")) or input_tokens + output_tokens
    cost_usd = _non_negative_float(usage.get("cost_usd"))
    if "provider_calls" in usage:
        provider_calls = _non_negative_int(usage.get("provider_calls"))
    elif isinstance(usage.get("provider_called"), bool):
        provider_calls = int(bool(usage["provider_called"]))
    else:
        provider_calls = int(
            bool(input_tokens or output_tokens or total_tokens or cost_usd)
            and not model.startswith("local-")
        )
    if "priced_calls" in usage:
        priced_calls = _non_negative_int(usage.get("priced_calls"))
    elif isinstance(usage.get("cost_reported"), bool):
        priced_calls = int(bool(usage["cost_reported"]) and provider_calls > 0)
    else:
        priced_calls = int(cost_usd > 0 and provider_calls > 0)
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cost_usd": cost_usd,
        "provider_calls": provider_calls,
        "priced_calls": min(provider_calls, priced_calls),
        "unpriced_calls": max(0, provider_calls - min(provider_calls, priced_calls)),
        "recorded_events": tuple(
            dict.fromkeys(
                str(item)
                for item in usage.get("recorded_events", ())
                if str(item or "").strip()
            )
        ),
    }


def merge_analysis_usage(existing: Any, incoming: Any) -> dict[str, Any]:
    before = _usage_totals(existing)
    delta = _usage_totals(incoming)
    provider_calls = before["provider_calls"] + delta["provider_calls"]
    priced_calls = before["priced_calls"] + delta["priced_calls"]
    recorded_events = tuple(
        dict.fromkeys((*before["recorded_events"], *delta["recorded_events"]))
    )
    return {
        "input_tokens": before["input_tokens"] + delta["input_tokens"],
        "output_tokens": before["output_tokens"] + delta["output_tokens"],
        "total_tokens": before["total_tokens"] + delta["total_tokens"],
        "cost_usd": before["cost_usd"] + delta["cost_usd"],
        "provider_calls": provider_calls,
        "priced_calls": priced_calls,
        "cost_complete": priced_calls >= provider_calls,
        "recorded_events": recorded_events,
    }


def record_analysis_usage_event(
    existing: Any,
    *,
    event_key: str,
    usage: Mapping[str, Any],
) -> tuple[dict[str, Any], bool]:
    """Append one provider event once, even if completion is cancelled later."""

    normalized_key = str(event_key or "").strip()
    if not normalized_key:
        raise ValueError("event_key must be a non-empty string")
    before = _usage_totals(existing)
    if normalized_key in before["recorded_events"]:
        return merge_analysis_usage(before, {}), False
    merged = merge_analysis_usage(
        before,
        {**dict(usage), "recorded_events": (normalized_key,)},
    )
    return merged, True


@dataclass(frozen=True, slots=True)
class AnalysisCostSummary:
    currency: str
    amount_usd: float
    complete: bool
    pricing_complete: bool
    provider_calls: int
    priced_calls: int
    unpriced_calls: int
    pending_jobs: int
    input_tokens: int
    output_tokens: int
    breakdown: dict[str, dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def summarize_analysis_cost(
    jobs: Iterable[Mapping[str, Any]],
) -> AnalysisCostSummary:
    totals: dict[str, Any] = {}
    breakdown: dict[str, dict[str, Any]] = {}
    pending_jobs = 0
    for job in jobs:
        purpose = str(job.get("purpose") or "")
        if purpose not in SESSION_COST_PURPOSES:
            continue
        totals = merge_analysis_usage(totals, job.get("usage"))
        breakdown[purpose] = merge_analysis_usage(
            breakdown.get(purpose, {}),
            job.get("usage"),
        )
        if str(job.get("status") or "") in {"queued", "running"}:
            pending_jobs += 1
    normalized = _usage_totals(totals)
    return AnalysisCostSummary(
        currency="USD",
        amount_usd=normalized["cost_usd"],
        complete=pending_jobs == 0,
        pricing_complete=normalized["priced_calls"] >= normalized["provider_calls"],
        provider_calls=normalized["provider_calls"],
        priced_calls=normalized["priced_calls"],
        unpriced_calls=normalized["unpriced_calls"],
        pending_jobs=pending_jobs,
        input_tokens=normalized["input_tokens"],
        output_tokens=normalized["output_tokens"],
        breakdown={
            purpose: {
                "amount_usd": values["cost_usd"],
                "provider_calls": values["provider_calls"],
                "priced_calls": values["priced_calls"],
                "unpriced_calls": values["unpriced_calls"],
                "input_tokens": values["input_tokens"],
                "output_tokens": values["output_tokens"],
            }
            for purpose, values in sorted(
                (purpose, _usage_totals(usage))
                for purpose, usage in breakdown.items()
            )
        },
    )
