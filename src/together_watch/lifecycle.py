from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from threading import RLock
from uuid import uuid4


class WorkStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    CANCELLED = "cancelled"


@dataclass(slots=True)
class SessionRuntime:
    session_id: str
    media_id: str
    timeline_epoch: int
    client_seen_at_ms: int
    client_lease_expires_at_ms: int
    ended: bool = False
    ended_reason: str = ""


@dataclass(slots=True)
class WorkItem:
    work_id: str
    session_id: str
    media_id: str
    timeline_epoch: int
    purpose: str
    epoch_sensitive: bool = True
    status: WorkStatus = WorkStatus.QUEUED
    cancel_requested: bool = False
    cancel_reason: str = ""
    lease_token: str = ""
    usage: dict = field(default_factory=dict)


class LifecycleError(RuntimeError):
    pass


class WorkCoordinator:
    """Storage-neutral reference for lease and worker cancellation semantics."""

    def __init__(self, *, client_lease_ms: int = 90_000) -> None:
        if isinstance(client_lease_ms, bool) or not isinstance(client_lease_ms, int):
            raise ValueError("client_lease_ms must be an integer")
        if client_lease_ms <= 0:
            raise ValueError("client_lease_ms must be greater than zero")
        self.client_lease_ms = client_lease_ms
        self._sessions: dict[str, SessionRuntime] = {}
        self._work: dict[str, WorkItem] = {}
        self._lock = RLock()

    def register_session(
        self,
        *,
        session_id: str,
        media_id: str,
        timeline_epoch: int,
        now_ms: int,
    ) -> SessionRuntime:
        with self._lock:
            if session_id in self._sessions:
                raise LifecycleError("session already registered")
            runtime = SessionRuntime(
                session_id=session_id,
                media_id=media_id,
                timeline_epoch=timeline_epoch,
                client_seen_at_ms=now_ms,
                client_lease_expires_at_ms=now_ms + self.client_lease_ms,
            )
            self._sessions[session_id] = runtime
            return runtime

    def get_session(self, session_id: str) -> SessionRuntime:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise LifecycleError("unknown session") from exc

    def get_work(self, work_id: str) -> WorkItem:
        try:
            return self._work[work_id]
        except KeyError as exc:
            raise LifecycleError("unknown work item") from exc

    def heartbeat(self, session_id: str, *, now_ms: int) -> SessionRuntime:
        with self._lock:
            runtime = self.get_session(session_id)
            if runtime.ended:
                raise LifecycleError("session_ended")
            runtime.client_seen_at_ms = now_ms
            runtime.client_lease_expires_at_ms = now_ms + self.client_lease_ms
            return runtime

    def schedule_eligibility(self, session_id: str, *, now_ms: int) -> tuple[bool, str]:
        with self._lock:
            runtime = self.get_session(session_id)
            if runtime.ended:
                return False, "session_ended"
            if runtime.client_lease_expires_at_ms <= now_ms:
                return False, "client_lease_expired"
            return True, ""

    def enqueue_work(
        self,
        *,
        work_id: str,
        session_id: str,
        purpose: str,
        now_ms: int,
        epoch_sensitive: bool = True,
    ) -> WorkItem:
        with self._lock:
            allowed, reason = self.schedule_eligibility(session_id, now_ms=now_ms)
            if not allowed:
                raise LifecycleError(reason)
            if work_id in self._work:
                raise LifecycleError("work item already exists")
            runtime = self.get_session(session_id)
            item = WorkItem(
                work_id=work_id,
                session_id=session_id,
                media_id=runtime.media_id,
                timeline_epoch=runtime.timeline_epoch,
                purpose=purpose,
                epoch_sensitive=epoch_sensitive,
            )
            self._work[work_id] = item
            return item

    def claim_next(self, *, now_ms: int) -> WorkItem | None:
        with self._lock:
            self.expire_abandoned_sessions(now_ms=now_ms)
            for item in self._work.values():
                if item.status != WorkStatus.QUEUED or item.cancel_requested:
                    continue
                item.status = WorkStatus.RUNNING
                item.lease_token = uuid4().hex
                return item
            return None

    def guard_work(self, work_id: str, lease_token: str, *, now_ms: int) -> str:
        with self._lock:
            item = self.get_work(work_id)
            runtime = self.get_session(item.session_id)
            if item.status != WorkStatus.RUNNING or item.lease_token != lease_token:
                return "lease_lost"
            if item.cancel_requested:
                return "cancel_requested"
            if runtime.ended:
                return "session_ended"
            if runtime.client_lease_expires_at_ms <= now_ms:
                return "client_lease_expired"
            if item.media_id != runtime.media_id or (
                item.epoch_sensitive and item.timeline_epoch != runtime.timeline_epoch
            ):
                return "stale_timeline"
            return ""

    def complete_work(
        self,
        work_id: str,
        lease_token: str,
        *,
        now_ms: int,
        usage: dict,
    ) -> tuple[bool, str]:
        with self._lock:
            reason = self.guard_work(work_id, lease_token, now_ms=now_ms)
            item = self.get_work(work_id)
            if reason:
                if reason != "lease_lost":
                    item.status = WorkStatus.CANCELLED
                    item.cancel_requested = True
                    item.cancel_reason = reason
                    item.lease_token = ""
                return False, reason
            item.status = WorkStatus.DONE
            item.usage = dict(usage)
            item.lease_token = ""
            return True, ""

    def update_timeline(
        self,
        session_id: str,
        *,
        media_id: str,
        timeline_epoch: int,
    ) -> None:
        with self._lock:
            runtime = self.get_session(session_id)
            if runtime.ended:
                raise LifecycleError("session_ended")
            runtime.media_id = media_id
            runtime.timeline_epoch = timeline_epoch
            for item in self._work.values():
                if item.session_id != session_id or not item.epoch_sensitive:
                    continue
                if item.media_id == media_id and item.timeline_epoch == timeline_epoch:
                    continue
                if item.status == WorkStatus.QUEUED:
                    item.status = WorkStatus.CANCELLED
                    item.cancel_reason = "stale_timeline"
                elif item.status == WorkStatus.RUNNING:
                    item.cancel_requested = True
                    item.cancel_reason = "stale_timeline"

    def end_session(self, session_id: str, *, reason: str = "session_ended") -> dict:
        with self._lock:
            runtime = self.get_session(session_id)
            if runtime.ended:
                return {"queued_cancelled": 0, "running_cancel_requested": 0}
            runtime.ended = True
            runtime.ended_reason = reason
            queued = 0
            running = 0
            for item in self._work.values():
                if item.session_id != session_id:
                    continue
                if item.status == WorkStatus.QUEUED:
                    item.status = WorkStatus.CANCELLED
                    item.cancel_reason = reason
                    queued += 1
                elif item.status == WorkStatus.RUNNING and not item.cancel_requested:
                    item.cancel_requested = True
                    item.cancel_reason = reason
                    running += 1
            return {
                "queued_cancelled": queued,
                "running_cancel_requested": running,
            }

    def expire_abandoned_sessions(self, *, now_ms: int) -> tuple[str, ...]:
        with self._lock:
            expired: list[str] = []
            for runtime in self._sessions.values():
                if runtime.ended or runtime.client_lease_expires_at_ms > now_ms:
                    continue
                self.end_session(runtime.session_id, reason="client_lease_expired")
                expired.append(runtime.session_id)
            return tuple(expired)
