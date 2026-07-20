from __future__ import annotations

import json
from dataclasses import dataclass
from importlib.resources import files
from typing import Any, Mapping, Sequence


@dataclass(frozen=True, slots=True)
class PromptBundle:
    """Provider-neutral structured prompt ready for a host model adapter."""

    system_prompt: str
    user_prompt: str
    response_schema: Mapping[str, Any]
    prompt_id: str


def _resource_text(relative_path: str) -> str:
    return (
        files("together_watch")
        .joinpath(relative_path)
        .read_text(encoding="utf-8")
        .strip()
    )


def _resource_json(relative_path: str) -> Mapping[str, Any]:
    value = json.loads(_resource_text(relative_path))
    if not isinstance(value, dict):
        raise ValueError(f"prompt schema must be an object: {relative_path}")
    return value


def _render(template: str, values: Mapping[str, str]) -> str:
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", value)
    return rendered


def build_analysis_prompt(
    *,
    purpose: str,
    context: Mapping[str, Any],
    knowledge_mode: str,
    output_language: str = "Chinese",
) -> PromptBundle:
    normalized_purpose = str(purpose).strip().lower()
    if normalized_purpose not in {"identify", "timeline_prepass", "rolling"}:
        raise ValueError("purpose must be identify, timeline_prepass, or rolling")
    normalized_mode = str(knowledge_mode).strip().lower()
    if normalized_mode not in {"known", "needs_summary"}:
        raise ValueError("knowledge_mode must be known or needs_summary")

    system_prompt = _render(
        _resource_text("prompt_templates/analysis_system.txt"),
        {"output_language": str(output_language).strip() or "Chinese"},
    )
    background_file = (
        "prompt_templates/analysis_background_needed.txt"
        if normalized_mode == "needs_summary"
        else "prompt_templates/analysis_background_known.txt"
    )
    system_prompt += "\n\n" + _resource_text(background_file)
    user_prompt = _render(
        _resource_text("prompt_templates/analysis_user.txt"),
        {
            "purpose": normalized_purpose,
            "context_json": json.dumps(context, ensure_ascii=False, separators=(",", ":")),
        },
    )
    return PromptBundle(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response_schema=_resource_json("schemas/analysis_result.schema.json"),
        prompt_id="together-watch-analysis-v1",
    )


def build_knowledge_prompt(
    *,
    target: Mapping[str, Any],
    sources: Sequence[Mapping[str, Any]],
    output_language: str = "Chinese",
) -> PromptBundle:
    system_prompt = _render(
        _resource_text("prompt_templates/knowledge_system.txt"),
        {"output_language": str(output_language).strip() or "Chinese"},
    )
    user_prompt = _render(
        _resource_text("prompt_templates/knowledge_user.txt"),
        {
            "target_json": json.dumps(target, ensure_ascii=False, separators=(",", ":")),
            "sources_json": json.dumps(list(sources), ensure_ascii=False, separators=(",", ":")),
        },
    )
    return PromptBundle(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response_schema=_resource_json("schemas/knowledge_card.schema.json"),
        prompt_id="together-watch-knowledge-v1",
    )
