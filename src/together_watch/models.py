from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class KnowledgeMode(str, Enum):
    KNOWN = "known"
    NEEDS_SUMMARY = "needs_summary"


class FearMode(str, Enum):
    OFF = "off"
    WARN_ONLY = "warn_only"
    COVER_VIDEO = "cover_video"


class VisualContextMode(str, Enum):
    TEXT_ONLY = "text_only"
    TEXT_PLUS_CONTACT_SHEET = "text_plus_contact_sheet"


class SamplePurpose(str, Enum):
    IDENTIFY = "identify"
    TIMELINE_PREPASS = "timeline_prepass"
    ROLLING = "rolling"


class SampleManager(str, Enum):
    GATEWAY = "gateway"
    SERVICE = "service"
    CLIENT = "client"


class ViewingExitAction(str, Enum):
    CLEANUP = "cleanup"
    SAVE_PROGRESS = "save_progress"
    COMPLETE = "complete"


def _require_text(name: str, value: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")


def _require_non_negative(name: str, value: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")


@dataclass(frozen=True, slots=True)
class ClientCapabilities:
    playback_snapshot: bool
    local_media: bool = False
    client_sampling: bool = False
    danmaku_overlay: bool = False
    risk_overlay: bool = False
    visual_context: bool = False

    def __post_init__(self) -> None:
        for name in (
            "playback_snapshot",
            "local_media",
            "client_sampling",
            "danmaku_overlay",
            "risk_overlay",
            "visual_context",
        ):
            if not isinstance(getattr(self, name), bool):
                raise ValueError(f"{name} must be a boolean")
        if self.client_sampling and not self.local_media:
            raise ValueError("client_sampling requires local_media")


@dataclass(frozen=True, slots=True)
class LocalPlaybackCapabilities:
    can_play: bool
    can_seek: bool
    can_read_future: bool
    can_export_frames: bool
    can_export_audio: bool
    has_audio: bool
    is_drm: bool

    def __post_init__(self) -> None:
        for name in (
            "can_play",
            "can_seek",
            "can_read_future",
            "can_export_frames",
            "can_export_audio",
            "has_audio",
            "is_drm",
        ):
            if not isinstance(getattr(self, name), bool):
                raise ValueError(f"{name} must be a boolean")
        if not self.can_play:
            raise ValueError("local media must be playable")


@dataclass(frozen=True, slots=True)
class AudioSelection:
    track_id: str = ""
    language: str = ""
    label: str = ""


@dataclass(frozen=True, slots=True)
class SubtitleSelection:
    kind: str = "none"
    track_id: str = ""
    language: str = ""
    label: str = ""
    format: str = ""
    offset_ms: int = 0

    def __post_init__(self) -> None:
        if self.kind not in {"none", "embedded", "external"}:
            raise ValueError("subtitle kind must be none, embedded, or external")
        if self.kind != "none" and self.format not in {"srt", "vtt"}:
            raise ValueError("selected subtitles must use srt or vtt")
        if self.kind == "embedded" and not self.track_id.strip():
            raise ValueError("embedded subtitles require track_id")
        if isinstance(self.offset_ms, bool) or not isinstance(self.offset_ms, int):
            raise ValueError("subtitle offset_ms must be an integer")


@dataclass(frozen=True, slots=True)
class LocalMediaDescriptor:
    local_asset_id: str
    media_revision: str
    capabilities: LocalPlaybackCapabilities
    selected_audio: AudioSelection = field(default_factory=AudioSelection)
    selected_subtitle: SubtitleSelection = field(default_factory=SubtitleSelection)

    def __post_init__(self) -> None:
        _require_text("local_asset_id", self.local_asset_id)
        _require_text("media_revision", self.media_revision)
        if self.capabilities.has_audio and not self.selected_audio.track_id.strip():
            raise ValueError("local media with audio requires a selected audio track")


@dataclass(frozen=True, slots=True)
class MediaDescriptor:
    media_id: str
    source: str
    title: str
    duration_ms: int
    part_title: str = ""
    work_key: str = ""
    cover_url: str = ""
    part_key: str = ""
    part_index: int = 1
    part_count: int = 1
    content_start_ms: int | None = None
    content_end_ms: int | None = None
    local_media: LocalMediaDescriptor | None = None

    def __post_init__(self) -> None:
        _require_text("media_id", self.media_id)
        _require_text("source", self.source)
        _require_text("title", self.title)
        if isinstance(self.duration_ms, bool) or not isinstance(self.duration_ms, int):
            raise ValueError("duration_ms must be an integer")
        if self.duration_ms <= 0:
            raise ValueError("duration_ms must be greater than zero")
        for name in ("part_index", "part_count"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if self.part_index > self.part_count:
            raise ValueError("part_index cannot exceed part_count")
        if not self.part_key.strip():
            object.__setattr__(self, "part_key", self.media_id)
        for name in ("content_start_ms", "content_end_ms"):
            value = getattr(self, name)
            if value is not None:
                _require_non_negative(name, value)
        if self.content_start_ms is not None and self.content_start_ms >= self.duration_ms:
            raise ValueError("content_start_ms must be earlier than media duration")
        if self.content_end_ms is not None and self.content_end_ms > self.duration_ms:
            raise ValueError("content_end_ms cannot exceed media duration")
        if (
            self.content_start_ms is not None
            and self.content_end_ms is not None
            and self.content_start_ms >= self.content_end_ms
        ):
            raise ValueError("content_start_ms must be earlier than content_end_ms")
        if self.source == "local_file":
            if self.local_media is None:
                raise ValueError("local_file media requires local_media")
            if self.media_id != f"local:{self.local_media.local_asset_id}":
                raise ValueError("local media_id must equal local:<local_asset_id>")
        elif self.local_media is not None:
            raise ValueError("local_media is only valid for local_file sources")


@dataclass(frozen=True, slots=True)
class SessionMode:
    knowledge_mode: KnowledgeMode
    fear_mode: FearMode = FearMode.OFF
    visual_context_mode: VisualContextMode = VisualContextMode.TEXT_ONLY
    reply_lead_ms: int = 30_000
    danmaku_enabled: bool = True

    def __post_init__(self) -> None:
        try:
            object.__setattr__(self, "knowledge_mode", KnowledgeMode(self.knowledge_mode))
            object.__setattr__(self, "fear_mode", FearMode(self.fear_mode))
            object.__setattr__(
                self,
                "visual_context_mode",
                VisualContextMode(self.visual_context_mode),
            )
        except ValueError as exc:
            raise ValueError("session mode contains an unsupported value") from exc
        _require_non_negative("reply_lead_ms", self.reply_lead_ms)
        if self.reply_lead_ms > 120_000:
            raise ValueError("reply_lead_ms cannot exceed 120000")
        if not isinstance(self.danmaku_enabled, bool):
            raise ValueError("danmaku_enabled must be a boolean")


@dataclass(frozen=True, slots=True)
class PlaybackSnapshot:
    media_id: str
    playhead_ms: int
    duration_ms: int
    is_playing: bool
    playback_rate: float
    timeline_epoch: int
    snapshot_seq: int
    captured_at: str

    def __post_init__(self) -> None:
        _require_text("media_id", self.media_id)
        _require_non_negative("playhead_ms", self.playhead_ms)
        if isinstance(self.duration_ms, bool) or not isinstance(self.duration_ms, int):
            raise ValueError("duration_ms must be an integer")
        if self.duration_ms <= 0:
            raise ValueError("duration_ms must be greater than zero")
        if self.playhead_ms > self.duration_ms:
            raise ValueError("playhead_ms cannot exceed duration_ms")
        if not isinstance(self.is_playing, bool):
            raise ValueError("is_playing must be a boolean")
        if isinstance(self.playback_rate, bool) or not isinstance(
            self.playback_rate, (int, float)
        ):
            raise ValueError("playback_rate must be a number")
        if not 0.25 <= float(self.playback_rate) <= 4.0:
            raise ValueError("playback_rate must be between 0.25 and 4.0")
        _require_non_negative("timeline_epoch", self.timeline_epoch)
        if isinstance(self.snapshot_seq, bool) or not isinstance(self.snapshot_seq, int):
            raise ValueError("snapshot_seq must be an integer")
        if self.snapshot_seq <= 0:
            raise ValueError("snapshot_seq must be greater than zero")
        _require_text("captured_at", self.captured_at)


@dataclass(slots=True)
class WatchSession:
    session_id: str
    media: MediaDescriptor
    mode: SessionMode
    capabilities: ClientCapabilities
    started: bool = False
    snapshot: PlaybackSnapshot | None = None


@dataclass(frozen=True, slots=True)
class ViewingPartSummary:
    part_key: str
    media_id: str
    part_index: int
    part_title: str
    played_duration_ms: int
    completed_at: str = ""
    completion_event_id: str = ""
    last_session_id: str = ""

    def __post_init__(self) -> None:
        _require_text("part_key", self.part_key)
        _require_text("media_id", self.media_id)
        if isinstance(self.part_index, bool) or not isinstance(self.part_index, int):
            raise ValueError("part_index must be an integer")
        if self.part_index <= 0:
            raise ValueError("part_index must be greater than zero")
        _require_non_negative("played_duration_ms", self.played_duration_ms)


@dataclass(frozen=True, slots=True)
class CompanionIdentity:
    id: str = ""
    name: str = ""


@dataclass(frozen=True, slots=True)
class ViewingFrame:
    frame_id: str
    media_id: str
    at_ms: int
    image_url: str
    selected_at: str

    def __post_init__(self) -> None:
        for name in ("frame_id", "media_id", "image_url", "selected_at"):
            _require_text(name, getattr(self, name))
        _require_non_negative("at_ms", self.at_ms)


@dataclass(frozen=True, slots=True)
class ViewingFrameCapture:
    frame_id: str
    viewing_id: str
    session_id: str
    media_id: str
    timeline_epoch: int
    at_ms: int
    width: int
    height: int
    mime_type: str
    image_url: str
    created_at: str

    def __post_init__(self) -> None:
        for name in (
            "frame_id",
            "viewing_id",
            "session_id",
            "media_id",
            "mime_type",
            "image_url",
            "created_at",
        ):
            _require_text(name, getattr(self, name))
        _require_non_negative("timeline_epoch", self.timeline_epoch)
        _require_non_negative("at_ms", self.at_ms)
        for name in ("width", "height"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if self.mime_type.strip().lower() != "image/jpeg":
            raise ValueError("ticket frame captures must use image/jpeg")
        object.__setattr__(self, "mime_type", "image/jpeg")


@dataclass(frozen=True, slots=True)
class ViewingTicket:
    ticket_id: str
    viewing_id: str
    work_key: str
    title: str
    cover_url: str
    companion: CompanionIdentity
    created_at: str
    completed_at: str
    played_duration_ms: int
    part_count: int
    completed_parts: tuple[ViewingPartSummary, ...]
    last_session_id: str
    back_frame: ViewingFrame | None = None

    def __post_init__(self) -> None:
        for name in ("ticket_id", "viewing_id", "work_key", "title", "created_at", "completed_at"):
            _require_text(name, getattr(self, name))
        _require_non_negative("played_duration_ms", self.played_duration_ms)
        if isinstance(self.part_count, bool) or not isinstance(self.part_count, int):
            raise ValueError("part_count must be an integer")
        if self.part_count <= 0:
            raise ValueError("part_count must be greater than zero")
        object.__setattr__(self, "completed_parts", tuple(self.completed_parts))


@dataclass(frozen=True, slots=True)
class ViewingProgress:
    viewing_id: str
    work_key: str
    title: str
    cover_url: str
    source: str
    source_reference: str
    media_id: str
    part_key: str
    part_index: int
    part_count: int
    part_title: str
    playhead_ms: int
    duration_ms: int
    played_duration_ms: int
    saved_at: str
    analysis_covered_until_ms: int = 0
    analysis_retained: bool = False
    ticket_back_frame: ViewingFrame | None = None

    def __post_init__(self) -> None:
        for name in (
            "viewing_id",
            "work_key",
            "title",
            "source",
            "media_id",
            "part_key",
            "saved_at",
        ):
            _require_text(name, getattr(self, name))
        for name in ("part_index", "part_count"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if self.part_index > self.part_count:
            raise ValueError("part_index cannot exceed part_count")
        _require_non_negative("playhead_ms", self.playhead_ms)
        if isinstance(self.duration_ms, bool) or not isinstance(self.duration_ms, int):
            raise ValueError("duration_ms must be an integer")
        if self.duration_ms <= 0:
            raise ValueError("duration_ms must be greater than zero")
        if self.playhead_ms > self.duration_ms:
            raise ValueError("playhead_ms cannot exceed duration_ms")
        _require_non_negative("played_duration_ms", self.played_duration_ms)
        _require_non_negative("analysis_covered_until_ms", self.analysis_covered_until_ms)
        if not isinstance(self.analysis_retained, bool):
            raise ValueError("analysis_retained must be a boolean")


@dataclass(frozen=True, slots=True)
class ViewingSummary:
    viewing_id: str
    work_key: str
    title: str
    cover_url: str
    companion: CompanionIdentity
    part_count: int
    parts: tuple[ViewingPartSummary, ...]
    played_duration_ms: int
    completed: bool
    completed_at: str
    ticket: ViewingTicket | None
    created_at: str
    updated_at: str
    progress: ViewingProgress | None = None
    completed_analysis_cache_expires_at: str = ""

    def __post_init__(self) -> None:
        for name in ("viewing_id", "work_key", "title", "created_at", "updated_at"):
            _require_text(name, getattr(self, name))
        if isinstance(self.part_count, bool) or not isinstance(self.part_count, int):
            raise ValueError("part_count must be an integer")
        if self.part_count <= 0:
            raise ValueError("part_count must be greater than zero")
        _require_non_negative("played_duration_ms", self.played_duration_ms)
        if not isinstance(self.completed, bool):
            raise ValueError("completed must be a boolean")
        object.__setattr__(self, "parts", tuple(self.parts))


@dataclass(frozen=True, slots=True)
class ViewingUpdateResult:
    played_delta_ms: int
    part_completed: bool
    viewing_completed: bool
    summary: ViewingSummary

    def __post_init__(self) -> None:
        _require_non_negative("played_delta_ms", self.played_delta_ms)


@dataclass(frozen=True, slots=True)
class PlotChunk:
    chunk_id: str
    session_id: str
    timeline_epoch: int
    start_ms: int
    end_ms: int
    summary: str
    dialogue_summary: str = ""
    tags: tuple[str, ...] = field(default_factory=tuple)
    characters: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        _require_text("chunk_id", self.chunk_id)
        _require_text("session_id", self.session_id)
        _require_non_negative("timeline_epoch", self.timeline_epoch)
        _require_non_negative("start_ms", self.start_ms)
        _require_non_negative("end_ms", self.end_ms)
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")
        _require_text("summary", self.summary)
        object.__setattr__(self, "tags", tuple(str(item) for item in self.tags))
        object.__setattr__(self, "characters", tuple(str(item) for item in self.characters))


@dataclass(frozen=True, slots=True)
class RiskEvent:
    risk_id: str
    session_id: str
    timeline_epoch: int
    warn_at_ms: int
    start_ms: int
    end_ms: int
    severity: float
    categories: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        _require_text("risk_id", self.risk_id)
        _require_text("session_id", self.session_id)
        _require_non_negative("timeline_epoch", self.timeline_epoch)
        _require_non_negative("warn_at_ms", self.warn_at_ms)
        _require_non_negative("start_ms", self.start_ms)
        _require_non_negative("end_ms", self.end_ms)
        if self.warn_at_ms > self.start_ms:
            raise ValueError("warn_at_ms cannot be later than start_ms")
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")
        if isinstance(self.severity, bool) or not isinstance(self.severity, (int, float)):
            raise ValueError("severity must be a number")
        if not 0.0 <= float(self.severity) <= 1.0:
            raise ValueError("severity must be between 0.0 and 1.0")
        object.__setattr__(self, "categories", tuple(str(item) for item in self.categories))


@dataclass(frozen=True, slots=True)
class DanmakuAction:
    action_id: str
    session_id: str
    media_id: str
    timeline_epoch: int
    target_ms: int
    text: str

    def __post_init__(self) -> None:
        _require_text("action_id", self.action_id)
        _require_text("session_id", self.session_id)
        _require_text("media_id", self.media_id)
        _require_non_negative("timeline_epoch", self.timeline_epoch)
        _require_non_negative("target_ms", self.target_ms)
        _require_text("text", self.text)


@dataclass(frozen=True, slots=True)
class SamplePlan:
    plan_id: str
    session_id: str
    media_id: str
    timeline_epoch: int
    purpose: SamplePurpose
    managed_by: SampleManager
    start_ms: int
    end_ms: int
    max_frames: int
    audio_required: bool
    media_revision: str = ""
    target_timestamps_ms: tuple[int, ...] = field(default_factory=tuple)
    expires_at: str = ""
    accepted_image_mime_types: tuple[str, ...] = field(default_factory=tuple)
    accepted_audio_mime_types: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        _require_text("plan_id", self.plan_id)
        _require_text("session_id", self.session_id)
        _require_text("media_id", self.media_id)
        try:
            object.__setattr__(self, "purpose", SamplePurpose(self.purpose))
            object.__setattr__(self, "managed_by", SampleManager(self.managed_by))
        except ValueError as exc:
            raise ValueError("sample plan contains an unsupported enum value") from exc
        _require_non_negative("timeline_epoch", self.timeline_epoch)
        _require_non_negative("start_ms", self.start_ms)
        _require_non_negative("end_ms", self.end_ms)
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")
        if isinstance(self.max_frames, bool) or not isinstance(self.max_frames, int):
            raise ValueError("max_frames must be an integer")
        if not 0 <= self.max_frames <= 8:
            raise ValueError("max_frames must be between 0 and 8")
        if not isinstance(self.audio_required, bool):
            raise ValueError("audio_required must be a boolean")
        object.__setattr__(
            self,
            "target_timestamps_ms",
            tuple(int(value) for value in self.target_timestamps_ms),
        )
        for value in self.target_timestamps_ms:
            if value < self.start_ms or value > self.end_ms:
                raise ValueError("sample timestamp is outside the allowed range")
        object.__setattr__(
            self,
            "accepted_image_mime_types",
            tuple(str(value) for value in self.accepted_image_mime_types),
        )
        object.__setattr__(
            self,
            "accepted_audio_mime_types",
            tuple(str(value) for value in self.accepted_audio_mime_types),
        )
        if self.managed_by == SampleManager.CLIENT:
            _require_text("media_revision", self.media_revision)
            _require_text("expires_at", self.expires_at)


@dataclass(frozen=True, slots=True)
class SnapshotApplyResult:
    applied: bool
    reason: str = ""


@dataclass(frozen=True, slots=True)
class ContextEnvelope:
    session_id: str
    media_id: str
    message_playhead_ms: int
    reply_arrival_until_ms: int
    story_background: str
    related_watched_chunks: tuple[PlotChunk, ...]
    current_chunks: tuple[PlotChunk, ...]
    reply_arrival_chunks: tuple[PlotChunk, ...]
    scheduled_future_chunks: tuple[PlotChunk, ...]
    timeline_epoch: int = 0
    visual_related_chunk_id: str = ""
    reply_latency: ReplyLatencyProfile | None = None


@dataclass(frozen=True, slots=True)
class ReplyLatencySample:
    job_id: str
    session_id: str
    latency_ms: int
    source: str = "gateway_first_visible"

    def __post_init__(self) -> None:
        _require_text("job_id", self.job_id)
        _require_text("session_id", self.session_id)
        _require_non_negative("latency_ms", self.latency_ms)
        if self.source not in {"gateway_first_visible", "client_displayed"}:
            raise ValueError("reply latency source is unsupported")


@dataclass(frozen=True, slots=True)
class ReplyLatencyProfile:
    sample_count: int
    average_latency_ms: int
    latest_latency_ms: int = 0
    latest_source: str = ""

    def __post_init__(self) -> None:
        _require_non_negative("sample_count", self.sample_count)
        _require_non_negative("average_latency_ms", self.average_latency_ms)
        _require_non_negative("latest_latency_ms", self.latest_latency_ms)


@dataclass(frozen=True, slots=True)
class VisualFrame:
    frame_id: str
    session_id: str
    media_id: str
    timeline_epoch: int
    at_ms: int

    def __post_init__(self) -> None:
        _require_text("frame_id", self.frame_id)
        _require_text("session_id", self.session_id)
        _require_text("media_id", self.media_id)
        _require_non_negative("timeline_epoch", self.timeline_epoch)
        _require_non_negative("at_ms", self.at_ms)


@dataclass(frozen=True, slots=True)
class VisualPanel:
    role: str
    purpose: str
    frame: VisualFrame

    def __post_init__(self) -> None:
        _require_text("role", self.role)
        _require_text("purpose", self.purpose)


@dataclass(frozen=True, slots=True)
class ActionValidation:
    valid: bool
    reason: str = ""
