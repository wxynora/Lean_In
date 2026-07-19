from __future__ import annotations

from collections.abc import Sequence
from uuid import uuid4

from .actions import create_danmaku_action, validate_danmaku_action
from .adapters import PlotRecallAdapter
from .context import build_context_envelope
from .models import (
    ActionValidation,
    ClientCapabilities,
    ContextEnvelope,
    DanmakuAction,
    MediaDescriptor,
    PlaybackSnapshot,
    PlotChunk,
    RiskEvent,
    SessionMode,
    SnapshotApplyResult,
    WatchSession,
)
from .recall import Bm25PlotRecall
from .timeline import TimelineTracker, scheduled_future_until_ms


class WatchCoreError(RuntimeError):
    pass


class WatchCore:
    def __init__(self, *, recall: PlotRecallAdapter | None = None) -> None:
        self._recall = recall or Bm25PlotRecall()
        self._sessions: dict[str, WatchSession] = {}
        self._timelines: dict[str, TimelineTracker] = {}
        self._chunks: dict[str, list[PlotChunk]] = {}
        self._risks: dict[str, list[RiskEvent]] = {}
        self._consumed_action_ids: set[str] = set()

    def create_session(
        self,
        *,
        media: MediaDescriptor,
        mode: SessionMode,
        capabilities: ClientCapabilities,
        session_id: str | None = None,
    ) -> WatchSession:
        if not capabilities.playback_snapshot:
            raise WatchCoreError("playback_snapshot capability is required")
        resolved_session_id = session_id or f"watch_{uuid4().hex}"
        if resolved_session_id in self._sessions:
            raise WatchCoreError("session_id already exists")
        session = WatchSession(
            session_id=resolved_session_id,
            media=media,
            mode=mode,
            capabilities=capabilities,
        )
        self._sessions[resolved_session_id] = session
        self._timelines[resolved_session_id] = TimelineTracker(media.media_id)
        self._chunks[resolved_session_id] = []
        self._risks[resolved_session_id] = []
        return session

    def get_session(self, session_id: str) -> WatchSession:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise WatchCoreError("unknown session") from exc

    def start_session(self, session_id: str) -> WatchSession:
        session = self.get_session(session_id)
        session.started = True
        return session

    def apply_snapshot(
        self,
        session_id: str,
        snapshot: PlaybackSnapshot,
    ) -> SnapshotApplyResult:
        session = self.get_session(session_id)
        if snapshot.is_playing and not session.started:
            return SnapshotApplyResult(False, "session_not_started")
        if snapshot.duration_ms != session.media.duration_ms:
            return SnapshotApplyResult(False, "duration_mismatch")
        result = self._timelines[session_id].apply(snapshot)
        if result.applied:
            session.snapshot = snapshot
        return result

    def add_plot_chunks(self, session_id: str, chunks: Sequence[PlotChunk]) -> None:
        session = self.get_session(session_id)
        for chunk in chunks:
            if chunk.session_id != session.session_id:
                raise WatchCoreError("plot chunk belongs to another session")
            if chunk.end_ms > session.media.duration_ms:
                raise WatchCoreError("plot chunk exceeds media duration")
        existing = {chunk.chunk_id: chunk for chunk in self._chunks[session_id]}
        existing.update({chunk.chunk_id: chunk for chunk in chunks})
        self._chunks[session_id] = list(existing.values())

    def add_risk_events(self, session_id: str, risks: Sequence[RiskEvent]) -> None:
        session = self.get_session(session_id)
        for risk in risks:
            if risk.session_id != session.session_id:
                raise WatchCoreError("risk event belongs to another session")
            if risk.end_ms > session.media.duration_ms:
                raise WatchCoreError("risk event exceeds media duration")
        existing = {risk.risk_id: risk for risk in self._risks[session_id]}
        existing.update({risk.risk_id: risk for risk in risks})
        self._risks[session_id] = list(existing.values())

    def build_context(
        self,
        session_id: str,
        *,
        recent_user_messages: str | Sequence[str] = (),
        story_background: str = "",
    ) -> ContextEnvelope:
        session = self.get_session(session_id)
        if not session.started:
            raise WatchCoreError("session is not started")
        snapshot = session.snapshot
        if snapshot is None:
            raise WatchCoreError("session has no playback snapshot")
        active_chunks = [
            chunk
            for chunk in self._chunks[session_id]
            if chunk.timeline_epoch == snapshot.timeline_epoch
        ]
        watched = [chunk for chunk in active_chunks if chunk.end_ms <= snapshot.playhead_ms]
        related = self._recall.recall(recent_user_messages, watched)
        return build_context_envelope(
            session_id=session_id,
            snapshot=snapshot,
            mode=session.mode,
            chunks=active_chunks,
            related_watched_chunks=related,
            story_background=story_background,
        )

    def upcoming_risks(self, session_id: str) -> tuple[RiskEvent, ...]:
        session = self.get_session(session_id)
        snapshot = session.snapshot
        if snapshot is None:
            return ()
        until_ms = scheduled_future_until_ms(snapshot)
        risks = [
            risk
            for risk in self._risks[session_id]
            if risk.timeline_epoch == snapshot.timeline_epoch
            and risk.end_ms >= snapshot.playhead_ms
            and risk.warn_at_ms <= until_ms
        ]
        return tuple(sorted(risks, key=lambda risk: (risk.warn_at_ms, risk.start_ms)))

    def prepare_danmaku(
        self,
        session_id: str,
        *,
        target_ms: int,
        text: str,
    ) -> tuple[DanmakuAction, ActionValidation]:
        session = self.get_session(session_id)
        if not session.mode.danmaku_enabled:
            raise WatchCoreError("danmaku is disabled")
        action = create_danmaku_action(session, target_ms=target_ms, text=text)
        if action.action_id in self._consumed_action_ids:
            return action, ActionValidation(False, "duplicate_action")
        validation = validate_danmaku_action(session, action)
        return action, validation

    def consume_action(self, action: DanmakuAction) -> None:
        self._consumed_action_ids.add(action.action_id)
