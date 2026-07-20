from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from .models import ActionValidation, DanmakuAction, WatchSession
from .timeline import scheduled_future_until_ms


DEFAULT_DANMAKU_MARKER = "watch:danmaku"
_MARKER_NAME_RE = re.compile(r"^[a-z][a-z0-9_.:-]*$", flags=re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class DanmakuMarkerIntent:
    target_ms: int
    text: str


def _normalize_marker_name(marker_name: str) -> str:
    normalized = str(marker_name or "").strip()
    if not _MARKER_NAME_RE.fullmatch(normalized):
        raise ValueError("marker_name contains unsupported characters")
    return normalized


def _clock_to_ms(value: str) -> int | None:
    parts = str(value or "").strip().split(":")
    if len(parts) not in {2, 3}:
        return None
    try:
        numbers = [int(part) for part in parts]
    except ValueError:
        return None
    if any(number < 0 for number in numbers) or numbers[-1] >= 60:
        return None
    if len(numbers) == 2:
        minutes, seconds = numbers
        return (minutes * 60 + seconds) * 1000
    hours, minutes, seconds = numbers
    if minutes >= 60:
        return None
    return (hours * 3600 + minutes * 60 + seconds) * 1000


def _parse_marker_payload(payload: str) -> DanmakuMarkerIntent | None:
    match = re.fullmatch(r"\s*(\d{1,3}:\d{2}(?::\d{2})?)\s+([\s\S]+?)\s*", payload)
    if not match:
        return None
    target_ms = _clock_to_ms(match.group(1))
    text = match.group(2).replace("\x00", "").strip()
    if target_ms is None or not text:
        return None
    return DanmakuMarkerIntent(target_ms=target_ms, text=text)


def _strip_partial_marker_suffix(text: str, marker_name: str) -> str:
    expected = "[" + marker_name.lower()
    scan_from = max(0, len(text) - len(expected))
    for index in range(scan_from, len(text)):
        candidate = text[index:]
        if not candidate.startswith("["):
            continue
        compact = re.sub(r"\s+", "", candidate).lower()
        if expected.startswith(compact):
            return text[:index].rstrip()
    return text


def split_danmaku_markers(
    response_text: str,
    *,
    marker_name: str = DEFAULT_DANMAKU_MARKER,
) -> tuple[str, tuple[DanmakuMarkerIntent, ...]]:
    """Remove hidden danmaku markers and return their provider-neutral intents."""
    text = str(response_text or "")
    normalized_name = _normalize_marker_name(marker_name)
    start_re = re.compile(
        r"\[\s*" + re.escape(normalized_name) + r"(?=\s|$)",
        flags=re.IGNORECASE,
    )
    visible_parts: list[str] = []
    intents: list[DanmakuMarkerIntent] = []
    cursor = 0
    while True:
        start = start_re.search(text, cursor)
        if start is None:
            visible_parts.append(text[cursor:])
            break
        visible_parts.append(text[cursor : start.start()])
        end = text.find("]", start.end())
        if end < 0:
            break
        intent = _parse_marker_payload(text[start.end() : end])
        if intent is not None:
            intents.append(intent)
        cursor = end + 1
    visible = _strip_partial_marker_suffix("".join(visible_parts), normalized_name)
    return visible, tuple(intents)


def visible_danmaku_stream_text(
    accumulated_text: str,
    *,
    marker_name: str = DEFAULT_DANMAKU_MARKER,
) -> str:
    """Return currently visible text without leaking complete or partial hidden markers."""
    visible, _intents = split_danmaku_markers(
        accumulated_text,
        marker_name=marker_name,
    )
    return visible


def stable_action_id(
    *,
    session_id: str,
    media_id: str,
    timeline_epoch: int,
    target_ms: int,
    text: str,
) -> str:
    material = "\x1f".join(
        [session_id, media_id, str(timeline_epoch), str(target_ms), text.strip()]
    )
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:20]
    return f"watch_action_{digest}"


def create_danmaku_action(
    session: WatchSession,
    *,
    target_ms: int,
    text: str,
) -> DanmakuAction:
    snapshot = session.snapshot
    if snapshot is None:
        raise ValueError("session has no playback snapshot")
    normalized_text = text.strip()
    return DanmakuAction(
        action_id=stable_action_id(
            session_id=session.session_id,
            media_id=session.media.media_id,
            timeline_epoch=snapshot.timeline_epoch,
            target_ms=target_ms,
            text=normalized_text,
        ),
        session_id=session.session_id,
        media_id=session.media.media_id,
        timeline_epoch=snapshot.timeline_epoch,
        target_ms=target_ms,
        text=normalized_text,
    )


def validate_danmaku_action(
    session: WatchSession,
    action: DanmakuAction,
    *,
    late_tolerance_ms: int = 1_500,
    max_text_length: int = 160,
) -> ActionValidation:
    snapshot = session.snapshot
    if not session.started:
        return ActionValidation(False, "session_not_started")
    if snapshot is None:
        return ActionValidation(False, "missing_playback_snapshot")
    if action.session_id != session.session_id:
        return ActionValidation(False, "session_mismatch")
    if action.media_id != session.media.media_id:
        return ActionValidation(False, "media_mismatch")
    if action.timeline_epoch != snapshot.timeline_epoch:
        return ActionValidation(False, "timeline_epoch_mismatch")
    if len(action.text) > max_text_length:
        return ActionValidation(False, "text_too_long")
    if action.target_ms < max(0, snapshot.playhead_ms - late_tolerance_ms):
        return ActionValidation(False, "target_expired")
    if action.target_ms > scheduled_future_until_ms(snapshot):
        return ActionValidation(False, "target_outside_future_window")
    return ActionValidation(True)
