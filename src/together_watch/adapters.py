from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Callable, Protocol, runtime_checkable

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


class SourceCandidateFailure(RuntimeError):
    """One signed source URL failed and another candidate may still work."""


class SourceSamplingFailure(RuntimeError):
    """Every candidate failed, including one fresh URL resolution."""


def sample_frames_with_refresh(
    timestamps_ms: Sequence[int],
    *,
    resolve_stream_urls: Callable[[], Sequence[str]],
    extract_frame: Callable[[str, int], bytes],
    on_candidate_failure: Callable[[int, int, int, Exception], None] | None = None,
) -> tuple[tuple[int, bytes], ...]:
    """Sample frames sequentially from fresh signed URLs with ordered fallback."""

    def normalized_urls() -> list[str]:
        urls: list[str] = []
        for value in resolve_stream_urls():
            url = str(value or "").strip()
            if url and url not in urls:
                urls.append(url)
        if not urls:
            raise SourceSamplingFailure("source resolver returned no stream candidates")
        return urls

    def extract_one(urls: list[str], at_ms: int) -> tuple[bytes, list[str]]:
        last_failure: SourceCandidateFailure | None = None
        for index, url in enumerate(urls):
            try:
                frame = bytes(extract_frame(url, at_ms) or b"")
                if not frame:
                    raise SourceCandidateFailure("candidate returned an empty frame")
            except SourceCandidateFailure as exc:
                last_failure = exc
                if on_candidate_failure is not None:
                    on_candidate_failure(at_ms, index + 1, len(urls), exc)
                continue
            if index > 0:
                urls = [url, *(candidate for candidate in urls if candidate != url)]
            return frame, urls
        raise SourceSamplingFailure("all source stream candidates failed") from last_failure

    ordered_urls = normalized_urls()
    samples: list[tuple[int, bytes]] = []
    for value in timestamps_ms:
        at_ms = max(0, int(value))
        try:
            frame, ordered_urls = extract_one(ordered_urls, at_ms)
        except SourceSamplingFailure:
            ordered_urls = normalized_urls()
            frame, ordered_urls = extract_one(ordered_urls, at_ms)
        samples.append((at_ms, frame))
    return tuple(samples)


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
