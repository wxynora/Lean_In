from __future__ import annotations

import json
import unittest
from pathlib import Path

from together_watch import (
    COMPANION_VISUAL_USER_LABEL,
    ContextEnvelope,
    PlotChunk,
    build_analysis_prompt,
    build_companion_context_prompt,
    build_knowledge_prompt,
)


class PromptBundleTests(unittest.TestCase):
    def test_companion_context_prompt_uses_placeholders_and_separates_future_actions(self) -> None:
        def plot(chunk_id: str, start_ms: int, end_ms: int, summary: str) -> PlotChunk:
            return PlotChunk(
                chunk_id=chunk_id,
                session_id="watch-demo",
                timeline_epoch=0,
                start_ms=start_ms,
                end_ms=end_ms,
                summary=summary,
            )

        prompt = build_companion_context_prompt(
            envelope=ContextEnvelope(
                session_id="watch-demo",
                media_id="movie-demo",
                message_playhead_ms=90_000,
                reply_arrival_until_ms=120_000,
                story_background="两人正在寻找失踪的钥匙。",
                related_watched_chunks=(plot("related", 20_000, 30_000, "门上出现过同样的标记。"),),
                current_chunks=(plot("current", 85_000, 100_000, "她在桌下发现一张地图。"),),
                reply_arrival_chunks=(plot("arrival", 105_000, 115_000, "地图边缘开始发光。"),),
                scheduled_future_chunks=(plot("future", 145_000, 155_000, "走廊突然响起警报。"),),
            ),
        )

        self.assertIn("你是{assistant}，正在和{viewer}一起看{work}", prompt)
        self.assertIn(
            "{viewer}正在和你看同一段，不需要和{viewer}照搬复述你看到的剧情内容以及逐项描述剧情画面。",
            prompt,
        )
        self.assertIn("剧情背景：", prompt)
        self.assertIn("当前剧情：", prompt)
        self.assertIn("与{viewer}说的相关的剧情：", prompt)
        self.assertIn("当前可见回复最多只能参考到 02:00", prompt)
        self.assertIn("预计当前可见回复抵达时，视频约播放到 02:00", prompt)
        self.assertIn("媒体时间是希望弹幕实际出现在画面上的时间", prompt)
        self.assertIn("这些内容不能写进当前可见回复", prompt)
        self.assertIn("[watch:danmaku 02:25 弹幕内容]", prompt)
        self.assertEqual(COMPANION_VISUAL_USER_LABEL, "【剧情画面】")

    def test_companion_context_prompt_omits_optional_sections(self) -> None:
        prompt = build_companion_context_prompt(
            envelope=ContextEnvelope(
                session_id="watch-demo",
                media_id="movie-demo",
                message_playhead_ms=0,
                reply_arrival_until_ms=0,
                story_background="",
                related_watched_chunks=(),
                current_chunks=(),
                reply_arrival_chunks=(),
                scheduled_future_chunks=(),
            ),
            analysis_ready=False,
            danmaku_enabled=False,
        )

        self.assertNotIn("剧情背景：", prompt)
        self.assertNotIn("相关的剧情：", prompt)
        self.assertIn("这一小段暂时没有可靠的剧情描述。", prompt)
        self.assertIn("没有可靠描述的部分不要自行补写。", prompt)
        self.assertIn("不要发送定时弹幕", prompt)

    def test_analysis_modes_change_only_background_contract(self) -> None:
        context = {
            "media": {"id": "movie:1", "duration_ms": 100_000},
            "previous_adjacent_plot_chunks": [
                {
                    "start_ms": 0,
                    "end_ms": 10_000,
                    "description": "The previous scene ends at a locked door.",
                    "characters": [],
                }
            ],
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
        self.assertIn("only to bridge the batch boundary", known.system_prompt)
        self.assertIn("not persistent analysis state", known.system_prompt)
        self.assertNotIn("story_so_far", known.response_schema["properties"])
        self.assertNotIn("story_state", known.response_schema["properties"])
        self.assertIn("story_background", known.response_schema["properties"])
        self.assertIn("PURPOSE=rolling", known.user_prompt)
        self.assertEqual(known.response_schema["title"], "Lean In analysis result")
        self.assertEqual(known.prompt_id, "together-watch-analysis-v2")

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
        self.assertEqual(prompt.response_schema["title"], "Lean In knowledge card")

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
