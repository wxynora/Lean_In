from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

from .models import (
    ContextEnvelope,
    DanmakuAction,
    PlaybackSnapshot,
    PlotChunk,
    RiskEvent,
    SamplePlan,
    WatchSession,
)
from .prompts import PromptBundle


@runtime_checkable
class PlaybackAdapter(Protocol):
    def snapshot(self) -> PlaybackSnapshot:
        """Return the player's current authoritative media snapshot."""


@runtime_checkable
class ClientSampleExporter(Protocol):
    def export(self, plan: SamplePlan) -> Mapping[str, Any]:
        """Export only the short audio and sparse frames allowed by the plan."""


@runtime_checkable
class AnalysisProvider(Protocol):
    def analyze(
        self,
        plan: SamplePlan,
        samples: Mapping[str, Any],
        previous_state: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        """Return provider-neutral plot, story-state, and risk data."""


@runtime_checkable
class KnowledgeProvider(Protocol):
    def prepare(self, media: Mapping[str, Any]) -> Mapping[str, Any]:
        """Return an optional pre-play work background card."""


@runtime_checkable
class KnowledgeSearchProvider(Protocol):
    def search(self, query: str, *, options: Mapping[str, Any]) -> Sequence[Mapping[str, Any]]:
        """Return normalized or provider-native search rows for knowledge-card preparation."""


@runtime_checkable
class StructuredModelProvider(Protocol):
    def generate(
        self,
        prompt: PromptBundle,
        *,
        media_parts: Sequence[Mapping[str, Any]] = (),
        options: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        """Run a structured text or multimodal request using a host-selected model transport."""


@runtime_checkable
class SubtitleProvider(Protocol):
    def resolve(self, media: Mapping[str, Any]) -> Mapping[str, Any] | None:
        """Return a normalized subtitle asset or an explicit no-result state."""


@runtime_checkable
class PlotRecallAdapter(Protocol):
    def recall(
        self,
        queries: str | Sequence[str],
        chunks: Sequence[PlotChunk],
        *,
        excluded_ids: set[str] | None = None,
    ) -> tuple[PlotChunk, ...]:
        """Recall related chunks from candidates supplied by the active session."""


@runtime_checkable
class ContextHostAdapter(Protocol):
    def inject(self, messages: Sequence[Mapping[str, Any]], envelope: ContextEnvelope) -> Any:
        """Convert a portable envelope to a host model request."""


@runtime_checkable
class ActionTransport(Protocol):
    def send(self, action: DanmakuAction) -> None:
        """Deliver a validated timed action to the active client."""


@runtime_checkable
class RuntimeStore(Protocol):
    def save_session(self, session: WatchSession) -> None: ...

    def get_session(self, session_id: str) -> WatchSession | None: ...

    def save_chunks(self, chunks: Sequence[PlotChunk]) -> None: ...

    def save_risks(self, risks: Sequence[RiskEvent]) -> None: ...
