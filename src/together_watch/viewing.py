from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from threading import RLock
from uuid import uuid4

from .models import (
    CompanionIdentity,
    MediaDescriptor,
    PlaybackSnapshot,
    ViewingExitAction,
    ViewingFrame,
    ViewingFrameCapture,
    ViewingPartSummary,
    ViewingProgress,
    ViewingSummary,
    ViewingTicket,
    ViewingUpdateResult,
)


class ViewingError(RuntimeError):
    pass


DEFAULT_COMPLETED_ANALYSIS_TTL_SECONDS = 24 * 60 * 60


def derive_work_key(media: MediaDescriptor) -> str:
    supplied = media.work_key.strip()
    if supplied:
        return supplied
    normalized_title = unicodedata.normalize("NFKC", media.title).casefold()
    title_key = "".join(character for character in normalized_title if character.isalnum())
    identity = f"{media.source.strip().casefold()}:{title_key or media.media_id}"
    return "watch_work_" + hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _stable_id(prefix: str, value: str) -> str:
    return prefix + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _iso_from_ms(value: int) -> str:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("observed_at_ms must be a non-negative integer")
    return (
        datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


@dataclass(slots=True)
class _PartState:
    part_key: str
    media_id: str
    part_index: int
    part_title: str
    duration_ms: int
    content_end_ms: int
    played_duration_ms: int = 0
    completed_at: str = ""
    completion_event_id: str = ""
    last_session_id: str = ""


@dataclass(slots=True)
class _ViewingState:
    viewing_id: str
    work_key: str
    title: str
    cover_url: str
    companion_id: str
    companion_name: str
    part_count: int
    parts: dict[str, _PartState]
    created_at: str
    updated_at: str
    completed_at: str = ""
    ticket: ViewingTicket | None = None
    progress: ViewingProgress | None = None
    ticket_back_frame: ViewingFrame | None = None
    ticket_frame_captures: dict[str, ViewingFrameCapture] = field(default_factory=dict)
    completed_analysis_cache_expires_at: str = ""


@dataclass(slots=True)
class _SessionState:
    session_id: str
    viewing_id: str
    part_key: str
    media_id: str
    media: MediaDescriptor
    source_reference: str = ""
    unlocked: bool = False
    ended: bool = False
    previous_snapshot: PlaybackSnapshot | None = None
    previous_observed_at_ms: int | None = None


class ViewingLedger:
    """Storage-neutral reference for trusted watch duration, completion, and tickets."""

    def __init__(
        self,
        *,
        completed_analysis_ttl_seconds: int = DEFAULT_COMPLETED_ANALYSIS_TTL_SECONDS,
    ) -> None:
        if (
            isinstance(completed_analysis_ttl_seconds, bool)
            or not isinstance(completed_analysis_ttl_seconds, int)
            or completed_analysis_ttl_seconds < 0
        ):
            raise ValueError("completed_analysis_ttl_seconds must be a non-negative integer")
        self.completed_analysis_ttl_seconds = completed_analysis_ttl_seconds
        self._viewings: dict[str, _ViewingState] = {}
        self._sessions: dict[str, _SessionState] = {}
        self._lock = RLock()

    def register_session(
        self,
        *,
        session_id: str,
        media: MediaDescriptor,
        observed_at_ms: int,
        viewing_id: str = "",
        companion_id: str = "",
        companion_name: str = "",
        source_reference: str = "",
    ) -> ViewingSummary:
        if not session_id.strip():
            raise ValueError("session_id must be a non-empty string")
        now_iso = _iso_from_ms(observed_at_ms)
        with self._lock:
            if session_id in self._sessions:
                raise ViewingError("session already registered")
            resolved_id = viewing_id.strip() or f"watch_viewing_{uuid4().hex}"
            work_key = derive_work_key(media)
            state = self._viewings.get(resolved_id)
            if state is None:
                state = _ViewingState(
                    viewing_id=resolved_id,
                    work_key=work_key,
                    title=media.title.strip(),
                    cover_url=media.cover_url.strip(),
                    companion_id=companion_id.strip(),
                    companion_name=companion_name.strip(),
                    part_count=media.part_count,
                    parts={},
                    created_at=now_iso,
                    updated_at=now_iso,
                )
                self._viewings[resolved_id] = state
            else:
                if state.work_key != work_key:
                    raise ViewingError("viewing_id belongs to another work")
                if state.ticket is not None:
                    raise ViewingError("viewing is already completed")
                state.part_count = max(state.part_count, media.part_count)
                if not state.cover_url and media.cover_url.strip():
                    state.cover_url = media.cover_url.strip()
                state.updated_at = now_iso

            conflicting_part = next(
                (
                    part
                    for part in state.parts.values()
                    if part.part_index == media.part_index and part.part_key != media.part_key
                ),
                None,
            )
            if conflicting_part is not None:
                raise ViewingError("part_index is already assigned to another part")
            part = state.parts.get(media.part_key)
            if part is None:
                state.parts[media.part_key] = _PartState(
                    part_key=media.part_key,
                    media_id=media.media_id,
                    part_index=media.part_index,
                    part_title=media.part_title.strip(),
                    duration_ms=media.duration_ms,
                    content_end_ms=media.content_end_ms or media.duration_ms,
                )
            elif part.media_id != media.media_id or part.part_index != media.part_index:
                raise ViewingError("part_key was reused with different media")

            self._sessions[session_id] = _SessionState(
                session_id=session_id,
                viewing_id=resolved_id,
                part_key=media.part_key,
                media_id=media.media_id,
                media=media,
                source_reference=source_reference.strip(),
            )
            state.progress = None
            return self._summary(state)

    def unlock_session(self, session_id: str) -> ViewingSummary:
        with self._lock:
            session = self._session(session_id)
            if session.ended:
                raise ViewingError("session_ended")
            session.unlocked = True
            return self._summary(self._viewings[session.viewing_id])

    def observe_playback(
        self,
        session_id: str,
        snapshot: PlaybackSnapshot,
        *,
        observed_at_ms: int,
        media_ended: bool = False,
    ) -> ViewingUpdateResult:
        if not isinstance(media_ended, bool):
            raise ValueError("media_ended must be a boolean")
        now_iso = _iso_from_ms(observed_at_ms)
        with self._lock:
            session = self._session(session_id)
            if session.ended:
                raise ViewingError("session_ended")
            if snapshot.media_id != session.media_id:
                raise ViewingError("snapshot belongs to another media")
            state = self._viewings[session.viewing_id]
            part = state.parts[session.part_key]
            if snapshot.duration_ms != part.duration_ms:
                raise ViewingError("snapshot duration does not match the registered part")
            previous = session.previous_snapshot
            previous_observed_at_ms = session.previous_observed_at_ms
            if previous is not None:
                if snapshot.timeline_epoch < previous.timeline_epoch:
                    raise ViewingError("stale_timeline")
                if (
                    snapshot.timeline_epoch == previous.timeline_epoch
                    and snapshot.snapshot_seq <= previous.snapshot_seq
                ):
                    raise ViewingError("stale_snapshot")
                if previous_observed_at_ms is not None and observed_at_ms < previous_observed_at_ms:
                    raise ViewingError("server observation time moved backwards")

            played_delta_ms = 0
            played_delta_ms = self._trusted_played_delta(
                previous,
                snapshot,
                previous_observed_at_ms=previous_observed_at_ms,
                observed_at_ms=observed_at_ms,
            )
            part.played_duration_ms += played_delta_ms
            part.last_session_id = session_id

            reached_end_continuously = bool(
                previous is not None
                and previous.timeline_epoch == snapshot.timeline_epoch
                and played_delta_ms > 0
            )
            reached_end = bool(
                session.unlocked
                and not part.completed_at
                and snapshot.playhead_ms >= part.content_end_ms
                and (reached_end_continuously or media_ended)
            )
            part_completed = False
            if reached_end:
                part.completed_at = now_iso
                part.completion_event_id = _stable_id(
                    "watch_completion_",
                    f"{state.viewing_id}:{part.part_key}",
                )
                part_completed = True

            session.previous_snapshot = snapshot
            session.previous_observed_at_ms = observed_at_ms
            state.updated_at = now_iso
            viewing_completed = self._complete_viewing_if_ready(
                state,
                completed_at=now_iso,
                last_session_id=session_id,
            )
            return ViewingUpdateResult(
                played_delta_ms=played_delta_ms,
                part_completed=part_completed,
                viewing_completed=viewing_completed,
                summary=self._summary(state),
            )

    def end_session(
        self,
        session_id: str,
        *,
        observed_at_ms: int,
        action: ViewingExitAction | str = ViewingExitAction.CLEANUP,
        analysis_covered_until_ms: int = 0,
    ) -> ViewingSummary:
        try:
            resolved_action = ViewingExitAction(action)
        except ValueError as exc:
            raise ValueError("unsupported viewing exit action") from exc
        if (
            isinstance(analysis_covered_until_ms, bool)
            or not isinstance(analysis_covered_until_ms, int)
            or analysis_covered_until_ms < 0
        ):
            raise ValueError("analysis_covered_until_ms must be a non-negative integer")
        now_iso = _iso_from_ms(observed_at_ms)
        with self._lock:
            session = self._session(session_id)
            session.ended = True
            state = self._viewings[session.viewing_id]
            state.updated_at = now_iso
            if resolved_action == ViewingExitAction.SAVE_PROGRESS:
                snapshot = session.previous_snapshot
                media = session.media
                state.progress = ViewingProgress(
                    viewing_id=state.viewing_id,
                    work_key=state.work_key,
                    title=state.title,
                    cover_url=state.cover_url,
                    source=media.source,
                    source_reference=session.source_reference,
                    media_id=media.media_id,
                    part_key=media.part_key,
                    part_index=media.part_index,
                    part_count=media.part_count,
                    part_title=media.part_title,
                    playhead_ms=snapshot.playhead_ms if snapshot else 0,
                    duration_ms=media.duration_ms,
                    played_duration_ms=sum(
                        part.played_duration_ms for part in state.parts.values()
                    ),
                    saved_at=now_iso,
                    analysis_covered_until_ms=analysis_covered_until_ms,
                    analysis_retained=True,
                    ticket_back_frame=state.ticket_back_frame,
                )
            elif resolved_action == ViewingExitAction.COMPLETE:
                state.progress = None
                if not state.completed_analysis_cache_expires_at:
                    state.completed_analysis_cache_expires_at = _iso_from_ms(
                        observed_at_ms + self.completed_analysis_ttl_seconds * 1000
                    )
                self._issue_ticket(
                    state,
                    ended_at=now_iso,
                    last_session_id=session_id,
                )
            return self._summary(state)

    def select_ticket_frame(
        self,
        viewing_id: str,
        frame: ViewingFrame,
        *,
        observed_at_ms: int,
    ) -> ViewingSummary:
        now_iso = _iso_from_ms(observed_at_ms)
        with self._lock:
            try:
                state = self._viewings[viewing_id]
            except KeyError as exc:
                raise ViewingError("unknown viewing") from exc
            if state.ticket is not None:
                raise ViewingError("viewing is already completed")
            if frame.media_id not in {part.media_id for part in state.parts.values()}:
                raise ViewingError("ticket frame belongs to another viewing")
            state.ticket_back_frame = frame
            if state.progress is not None:
                state.progress = replace(state.progress, ticket_back_frame=frame)
            state.updated_at = now_iso
            return self._summary(state)

    def save_ticket_frame_capture(
        self,
        viewing_id: str,
        *,
        session_id: str,
        media_id: str,
        timeline_epoch: int,
        at_ms: int,
        width: int,
        height: int,
        mime_type: str,
        image_url: str,
        observed_at_ms: int,
        frame_id: str = "",
    ) -> ViewingFrameCapture:
        now_iso = _iso_from_ms(observed_at_ms)
        with self._lock:
            try:
                state = self._viewings[viewing_id]
            except KeyError as exc:
                raise ViewingError("unknown viewing") from exc
            session = self._session(session_id)
            if session.viewing_id != viewing_id:
                raise ViewingError("capture belongs to another viewing")
            if session.media_id != media_id:
                raise ViewingError("capture belongs to another media")
            current_epoch = (
                session.previous_snapshot.timeline_epoch
                if session.previous_snapshot is not None
                else 0
            )
            if timeline_epoch != current_epoch:
                raise ViewingError("capture belongs to a stale timeline")
            if at_ms > session.media.duration_ms:
                raise ViewingError("capture time exceeds media duration")
            capture_id = frame_id.strip() or f"capture_{uuid4().hex}"
            if capture_id in state.ticket_frame_captures:
                raise ViewingError("capture id already exists")
            capture = ViewingFrameCapture(
                frame_id=capture_id,
                viewing_id=viewing_id,
                session_id=session_id,
                media_id=media_id,
                timeline_epoch=timeline_epoch,
                at_ms=at_ms,
                width=width,
                height=height,
                mime_type=mime_type,
                image_url=image_url,
                created_at=now_iso,
            )
            state.ticket_frame_captures[capture_id] = capture
            state.updated_at = now_iso
            return capture

    def list_ticket_frame_captures(
        self,
        viewing_id: str,
    ) -> tuple[ViewingFrameCapture, ...]:
        with self._lock:
            try:
                captures = self._viewings[viewing_id].ticket_frame_captures.values()
            except KeyError as exc:
                raise ViewingError("unknown viewing") from exc
            return tuple(captures)

    def select_ticket_frame_capture(
        self,
        viewing_id: str,
        capture_id: str,
        *,
        observed_at_ms: int,
    ) -> ViewingSummary:
        now_iso = _iso_from_ms(observed_at_ms)
        with self._lock:
            try:
                state = self._viewings[viewing_id]
            except KeyError as exc:
                raise ViewingError("unknown viewing") from exc
            try:
                capture = state.ticket_frame_captures[capture_id]
            except KeyError as exc:
                raise ViewingError("unknown ticket frame capture") from exc
            frame = ViewingFrame(
                frame_id=capture.frame_id,
                media_id=capture.media_id,
                at_ms=capture.at_ms,
                image_url=capture.image_url,
                selected_at=now_iso,
            )
            self._set_ticket_back_frame(state, frame)
            state.updated_at = now_iso
            return self._summary(state)

    def clear_ticket_frame(
        self,
        viewing_id: str,
        *,
        observed_at_ms: int,
    ) -> ViewingSummary:
        now_iso = _iso_from_ms(observed_at_ms)
        with self._lock:
            try:
                state = self._viewings[viewing_id]
            except KeyError as exc:
                raise ViewingError("unknown viewing") from exc
            self._set_ticket_back_frame(state, None)
            state.updated_at = now_iso
            return self._summary(state)

    def get_viewing(self, viewing_id: str) -> ViewingSummary:
        with self._lock:
            try:
                return self._summary(self._viewings[viewing_id])
            except KeyError as exc:
                raise ViewingError("unknown viewing") from exc

    def viewing_for_session(self, session_id: str) -> ViewingSummary:
        with self._lock:
            session = self._session(session_id)
            return self._summary(self._viewings[session.viewing_id])

    def list_tickets(self) -> tuple[ViewingTicket, ...]:
        with self._lock:
            tickets = [state.ticket for state in self._viewings.values() if state.ticket]
            return tuple(
                sorted(
                    tickets,
                    key=lambda ticket: (ticket.completed_at, ticket.ticket_id),
                    reverse=True,
                )
            )

    def list_resumable(self) -> tuple[ViewingProgress, ...]:
        with self._lock:
            progress = [state.progress for state in self._viewings.values() if state.progress]
            return tuple(
                sorted(
                    progress,
                    key=lambda item: (item.saved_at, item.viewing_id),
                    reverse=True,
                )
            )

    def update_ticket_title(
        self,
        ticket_id: str,
        *,
        title: str,
        observed_at_ms: int,
    ) -> ViewingTicket:
        clean_title = title.strip()
        if not clean_title:
            raise ValueError("title must be a non-empty string")
        now_iso = _iso_from_ms(observed_at_ms)
        with self._lock:
            state = next(
                (
                    candidate
                    for candidate in self._viewings.values()
                    if candidate.ticket is not None
                    and candidate.ticket.ticket_id == ticket_id
                ),
                None,
            )
            if state is None or state.ticket is None:
                raise ViewingError("unknown ticket")
            state.title = clean_title
            state.ticket = replace(state.ticket, title=clean_title)
            state.updated_at = now_iso
            return state.ticket

    @staticmethod
    def _trusted_played_delta(
        previous: PlaybackSnapshot | None,
        current: PlaybackSnapshot,
        *,
        previous_observed_at_ms: int | None,
        observed_at_ms: int,
    ) -> int:
        if (
            previous is None
            or previous_observed_at_ms is None
            or not previous.is_playing
            or previous.timeline_epoch != current.timeline_epoch
            or current.playhead_ms <= previous.playhead_ms
        ):
            return 0
        server_delta_ms = max(0, observed_at_ms - previous_observed_at_ms)
        media_delta_ms = current.playhead_ms - previous.playhead_ms
        playback_delta_ms = int(media_delta_ms / float(previous.playback_rate))
        return max(0, min(server_delta_ms, playback_delta_ms))

    def _complete_viewing_if_ready(
        self,
        state: _ViewingState,
        *,
        completed_at: str,
        last_session_id: str,
    ) -> bool:
        if state.completed_at:
            return False
        completed_indexes = {
            part.part_index for part in state.parts.values() if part.completed_at
        }
        required_indexes = set(range(1, state.part_count + 1))
        if not required_indexes.issubset(completed_indexes):
            return False
        state.completed_at = completed_at
        return True

    def _issue_ticket(
        self,
        state: _ViewingState,
        *,
        ended_at: str,
        last_session_id: str,
    ) -> ViewingTicket:
        if state.ticket is not None:
            return state.ticket
        state.ticket = ViewingTicket(
            ticket_id=_stable_id("watch_ticket_", state.viewing_id),
            viewing_id=state.viewing_id,
            work_key=state.work_key,
            title=state.title,
            cover_url=state.cover_url,
            companion=CompanionIdentity(
                id=state.companion_id,
                name=state.companion_name,
            ),
            created_at=ended_at,
            completed_at=ended_at,
            played_duration_ms=sum(
                part.played_duration_ms for part in state.parts.values()
            ),
            part_count=state.part_count,
            completed_parts=tuple(
                self._part_summary(part)
                for part in sorted(
                    state.parts.values(),
                    key=lambda item: (item.part_index, item.part_key),
                )
                if part.completed_at
            ),
            last_session_id=last_session_id,
            back_frame=state.ticket_back_frame,
        )
        return state.ticket

    def _session(self, session_id: str) -> _SessionState:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise ViewingError("unknown session") from exc

    @staticmethod
    def _set_ticket_back_frame(
        state: _ViewingState,
        frame: ViewingFrame | None,
    ) -> None:
        state.ticket_back_frame = frame
        if state.progress is not None:
            state.progress = replace(state.progress, ticket_back_frame=frame)
        if state.ticket is not None:
            state.ticket = replace(state.ticket, back_frame=frame)

    @staticmethod
    def _part_summary(part: _PartState) -> ViewingPartSummary:
        return ViewingPartSummary(
            part_key=part.part_key,
            media_id=part.media_id,
            part_index=part.part_index,
            part_title=part.part_title,
            played_duration_ms=part.played_duration_ms,
            completed_at=part.completed_at,
            completion_event_id=part.completion_event_id,
            last_session_id=part.last_session_id,
        )

    def _summary(self, state: _ViewingState) -> ViewingSummary:
        parts = tuple(
            self._part_summary(part)
            for part in sorted(
                state.parts.values(),
                key=lambda item: (item.part_index, item.part_key),
            )
        )
        return ViewingSummary(
            viewing_id=state.viewing_id,
            work_key=state.work_key,
            title=state.title,
            cover_url=state.cover_url,
            companion=CompanionIdentity(
                id=state.companion_id,
                name=state.companion_name,
            ),
            part_count=state.part_count,
            parts=parts,
            played_duration_ms=sum(part.played_duration_ms for part in state.parts.values()),
            completed=bool(state.completed_at),
            completed_at=state.completed_at,
            ticket=state.ticket,
            created_at=state.created_at,
            updated_at=state.updated_at,
            progress=state.progress,
            completed_analysis_cache_expires_at=state.completed_analysis_cache_expires_at,
        )
