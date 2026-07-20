from __future__ import annotations

import json
from dataclasses import dataclass
from importlib.resources import files
from typing import Any, Mapping, Sequence

from .actions import DEFAULT_DANMAKU_MARKER
from .models import ContextEnvelope, PlotChunk


COMPANION_VISUAL_USER_LABEL = "【剧情画面】"


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


def _media_clock(milliseconds: int) -> str:
    total_seconds = max(0, int(milliseconds)) // 1000
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def _format_companion_chunks(chunks: Sequence[PlotChunk]) -> str:
    lines: list[str] = []
    for chunk in chunks:
        description = chunk.summary.strip()
        dialogue = chunk.dialogue_summary.strip()
        if dialogue:
            description = f"{description}；对白：{dialogue}"
        lines.append(
            f"- {_media_clock(chunk.start_ms)}-{_media_clock(chunk.end_ms)}：{description}"
        )
    return "\n".join(lines)


def build_companion_context_prompt(
    *,
    envelope: ContextEnvelope,
    assistant_name: str = "{assistant}",
    viewer_name: str = "{viewer}",
    work_name: str = "{work}",
    analysis_ready: bool = True,
    danmaku_enabled: bool = True,
    danmaku_marker: str = DEFAULT_DANMAKU_MARKER,
) -> str:
    """Render the session envelope as a private-name-free dynamic system prompt."""

    marker = str(danmaku_marker).strip()
    if not marker or any(character.isspace() or character in "[]" for character in marker):
        raise ValueError("danmaku_marker must be a non-empty marker name without spaces or brackets")

    story_background_section = ""
    if envelope.story_background.strip():
        story_background_section = "\n\n" + "\n".join(
            [
                "剧情背景：",
                envelope.story_background.strip(),
                "这部分只用于认人、补前因和保持连贯，不要主动复述成资料介绍。",
            ]
        )

    current_chunks = _format_companion_chunks(envelope.current_chunks)
    if not current_chunks:
        current_chunks = "这一小段暂时没有可靠的剧情描述。"

    related_chunks_section = ""
    related_chunks = _format_companion_chunks(envelope.related_watched_chunks)
    if related_chunks:
        related_chunks_section = "\n\n" + "\n".join(
            [
                f"与{str(viewer_name).strip() or '{viewer}'}说的相关的剧情：",
                related_chunks,
                "这些片段只来自本次一起看已经播放的内容。只在确实相关时自然联系，不要为了证明记得而复述。",
            ]
        )

    reply_arrival_section = ""
    reply_arrival_chunks = _format_companion_chunks(envelope.reply_arrival_chunks)
    if reply_arrival_chunks:
        reply_arrival_section = "\n\n" + "\n".join(
            [
                "后续的剧情（这部分用于同步回复抵达时的观看进度）：",
                reply_arrival_chunks,
                f"当前可见回复最多只能参考到 {_media_clock(envelope.reply_arrival_until_ms)}。",
            ]
        )

    reliability_section = ""
    if not analysis_ready:
        reliability_section = "\n\n没有可靠描述的部分不要自行补写。"

    scheduled_future_section = "本轮没有可用的未来动作片段，不要发送定时弹幕。"
    scheduled_future_chunks = _format_companion_chunks(envelope.scheduled_future_chunks)
    if danmaku_enabled and scheduled_future_chunks:
        example_time = _media_clock(envelope.scheduled_future_chunks[0].start_ms)
        scheduled_future_section = "\n".join(
            [
                "【定时观看反应】",
                "下面是晚于当前可见回复范围、只可用于定时弹幕的剧情：",
                scheduled_future_chunks,
                "这些内容不能写进当前可见回复，也不能暗示给观看者。",
                f"如果想发送弹幕，在回复末尾追加一行隐藏标记：[{marker} 媒体时间 弹幕内容]。",
                f"媒体时间必须落在上面提供的片段内，例如：[{marker} {example_time} 弹幕内容]。没有想发的就不要写。",
            ]
        )

    return _render(
        _resource_text("prompt_templates/companion_context_zh.txt"),
        {
            "assistant": str(assistant_name).strip() or "{assistant}",
            "viewer": str(viewer_name).strip() or "{viewer}",
            "work": str(work_name).strip() or "{work}",
            "story_background_section": story_background_section,
            "current_chunks": current_chunks,
            "related_chunks_section": related_chunks_section,
            "reply_arrival_section": reply_arrival_section,
            "reliability_section": reliability_section,
            "scheduled_future_section": scheduled_future_section,
        },
    )


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
