from __future__ import annotations

import json
import unittest
from pathlib import Path

from together_watch import build_analysis_prompt, build_knowledge_prompt


class PromptBundleTests(unittest.TestCase):
    def test_analysis_modes_change_only_background_contract(self) -> None:
        context = {
            "media": {"id": "movie:1", "duration_ms": 100_000},
            "previous_story_so_far": {"background": "old"},
        }
        known = build_analysis_prompt(
            purpose="rolling",
            context=context,
            knowledge_mode="known",
        )
        needed = build_analysis_prompt(
            purpose="rolling",
            context=context,
            knowledge_mode="needs_summary",
        )

        self.assertIn("BACKGROUND MODE: DO NOT PRODUCE", known.system_prompt)
        self.assertIn("BACKGROUND MODE: PRODUCE WHEN SAFE", needed.system_prompt)
        self.assertIn("PURPOSE=rolling", known.user_prompt)
        self.assertEqual(known.response_schema["title"], "TogetherWatch analysis result")

    def test_knowledge_prompt_contains_only_supplied_target_and_sources(self) -> None:
        prompt = build_knowledge_prompt(
            target={"title": "Example", "year": 2025},
            sources=[
                {
                    "source_id": "source-1",
                    "title": "Official",
                    "url": "https://example.invalid",
                }
            ],
        )

        self.assertIn('TARGET={"title":"Example","year":2025}', prompt.user_prompt)
        self.assertIn("source-1", prompt.user_prompt)
        self.assertEqual(prompt.response_schema["title"], "TogetherWatch knowledge card")

    def test_packaged_schemas_are_valid_json(self) -> None:
        root = Path(__file__).resolve().parents[1] / "src" / "together_watch" / "schemas"
        for path in root.glob("*.json"):
            self.assertIsInstance(json.loads(path.read_text(encoding="utf-8")), dict)

    def test_default_prompts_contain_no_private_product_identifiers(self) -> None:
        root = Path(__file__).resolve().parents[1] / "src" / "together_watch" / "prompt_templates"
        combined = "\n".join(path.read_text(encoding="utf-8") for path in root.glob("*.txt"))
        for private_name in ("SumiTalk", "du-gateway", "小玥", "渡"):
            self.assertNotIn(private_name, combined)


if __name__ == "__main__":
    unittest.main()
