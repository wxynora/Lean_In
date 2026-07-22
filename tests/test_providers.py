from __future__ import annotations

import json
import unittest
from pathlib import Path

from together_watch import (
    KnowledgeSearchConfig,
    KnowledgeSearchMode,
    ProviderSettings,
    build_knowledge_search_query,
)


class ProviderSettingsTests(unittest.TestCase):
    def test_example_configuration_loads(self) -> None:
        path = Path(__file__).resolve().parents[1] / "examples" / "provider_config.example.json"
        settings = ProviderSettings.from_mapping(json.loads(path.read_text(encoding="utf-8")))

        self.assertEqual(settings.analysis_model.model, "gemini-2.5-flash")
        self.assertIs(settings.knowledge_search.mode, KnowledgeSearchMode.EXTERNAL)
        self.assertEqual(settings.knowledge_search.api_key_env, "TOGETHER_WATCH_SEARCH_API_KEY")
        self.assertEqual(settings.subtitle_lookup.request_timeout_seconds, 15)
        self.assertEqual(settings.subtitle_lookup.lookup_timeout_seconds, 45)
        self.assertEqual(settings.subtitle_lookup.automatic_attempts, 1)
        self.assertFalse(settings.tmdb_identity.enabled)
        self.assertEqual(
            settings.tmdb_identity.read_access_token_env,
            "TOGETHER_WATCH_TMDB_READ_ACCESS_TOKEN",
        )

    def test_search_query_prefers_original_title_and_keeps_episode_context(self) -> None:
        query = build_knowledge_search_query(
            title="Display title",
            original_title="Original title",
            season="Season 2",
            episode="Episode 4",
            config=KnowledgeSearchConfig(mode="model_native"),
        )

        self.assertEqual(
            query,
            (
                "《Original title Season 2 Episode 4》"
                "剧情简介 主要人物 人物关系 世界观"
            ),
        )

    def test_query_template_is_replaceable(self) -> None:
        query = build_knowledge_search_query(
            title="Example",
            config=KnowledgeSearchConfig(
                mode="disabled",
                title_preference="title",
                query_template="background for {title}",
            ),
        )
        self.assertEqual(query, "background for Example")


if __name__ == "__main__":
    unittest.main()
