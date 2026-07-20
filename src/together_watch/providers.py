from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping

from .subtitles import SubtitleLookupPolicy


class KnowledgeSearchMode(str, Enum):
    EXTERNAL = "external"
    MODEL_NATIVE = "model_native"
    DISABLED = "disabled"


@dataclass(frozen=True, slots=True)
class ModelProviderConfig:
    """Configuration metadata consumed by a host-owned model transport."""

    provider: str
    model: str
    transport: str = "gemini"
    endpoint: str = ""
    api_key_env: str = ""
    options: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.provider.strip():
            raise ValueError("model provider must not be blank")
        if not self.model.strip():
            raise ValueError("model name must not be blank")


@dataclass(frozen=True, slots=True)
class KnowledgeSearchConfig:
    """Explicit search selection; the core never silently chooses a private provider."""

    mode: KnowledgeSearchMode = KnowledgeSearchMode.MODEL_NATIVE
    provider: str = ""
    endpoint: str = ""
    api_key_env: str = ""
    query_template: str = "《{title}》剧情简介 主要人物 人物关系 世界观"
    title_preference: str = "original_title"
    options: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.mode, KnowledgeSearchMode):
            object.__setattr__(self, "mode", KnowledgeSearchMode(self.mode))
        if "{title}" not in self.query_template:
            raise ValueError("knowledge search query_template must contain {title}")
        if self.title_preference not in {"title", "original_title"}:
            raise ValueError("title_preference must be title or original_title")
        if self.mode is KnowledgeSearchMode.EXTERNAL and not self.provider.strip():
            raise ValueError("external knowledge search requires a provider name")


@dataclass(frozen=True, slots=True)
class ProviderSettings:
    analysis_model: ModelProviderConfig
    knowledge_model: ModelProviderConfig
    knowledge_search: KnowledgeSearchConfig = field(default_factory=KnowledgeSearchConfig)
    subtitle_lookup: SubtitleLookupPolicy = field(default_factory=SubtitleLookupPolicy)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> ProviderSettings:
        analysis = value.get("analysis_model")
        knowledge = value.get("knowledge_model")
        search = value.get("knowledge_search", {})
        subtitle_lookup = value.get("subtitle_lookup", {})
        if not isinstance(analysis, Mapping) or not isinstance(knowledge, Mapping):
            raise ValueError("analysis_model and knowledge_model must be objects")
        if not isinstance(search, Mapping):
            raise ValueError("knowledge_search must be an object")
        if not isinstance(subtitle_lookup, Mapping):
            raise ValueError("subtitle_lookup must be an object")
        return cls(
            analysis_model=ModelProviderConfig(**dict(analysis)),
            knowledge_model=ModelProviderConfig(**dict(knowledge)),
            knowledge_search=KnowledgeSearchConfig(**dict(search)),
            subtitle_lookup=SubtitleLookupPolicy(**dict(subtitle_lookup)),
        )


def build_knowledge_search_query(
    *,
    title: str,
    original_title: str = "",
    season: str = "",
    episode: str = "",
    part_title: str = "",
    config: KnowledgeSearchConfig | None = None,
) -> str:
    settings = config or KnowledgeSearchConfig()
    preferred = (
        original_title.strip()
        if settings.title_preference == "original_title" and original_title.strip()
        else title.strip()
    )
    if not preferred:
        preferred = original_title.strip()
    if not preferred:
        raise ValueError("knowledge search requires a title or original_title")
    suffix = " ".join(
        value.strip()
        for value in (season, episode, part_title)
        if value and value.strip() and value.strip() not in preferred
    )
    target = " ".join(part for part in (preferred, suffix) if part)
    return settings.query_template.format(title=target)
