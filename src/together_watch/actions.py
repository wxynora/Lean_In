from __future__ import annotations

import hashlib

from .models import ActionValidation, DanmakuAction, WatchSession
from .timeline import scheduled_future_until_ms


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
