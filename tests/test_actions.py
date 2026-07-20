from __future__ import annotations

import unittest

from together_watch import (
    ClientCapabilities,
    KnowledgeMode,
    MediaDescriptor,
    PlaybackSnapshot,
    SessionMode,
    WatchCore,
    split_danmaku_markers,
    visible_danmaku_stream_text,
)


class HiddenDanmakuMarkerTest(unittest.TestCase):
    def test_markers_are_removed_and_parsed_in_order(self) -> None:
        visible, intents = split_danmaku_markers(
            "I saw that clue.\n"
            "[watch:danmaku 02:05 Look at the key.]\n"
            "[watch:danmaku 01:02:03 That sound again.]"
        )

        self.assertEqual(visible, "I saw that clue.\n\n")
        self.assertEqual(
            [(intent.target_ms, intent.text) for intent in intents],
            [
                (125_000, "Look at the key."),
                (3_723_000, "That sound again."),
            ],
        )

    def test_invalid_or_unclosed_markers_fail_closed(self) -> None:
        visible, intents = split_danmaku_markers(
            "Visible reply.\n[watch:danmaku 00:99 invalid time]"
            "\n[watch:danmaku 00:30 unfinished"
        )

        self.assertEqual(visible.strip(), "Visible reply.")
        self.assertEqual(intents, ())

    def test_partial_stream_marker_is_not_visible(self) -> None:
        self.assertEqual(
            visible_danmaku_stream_text("Visible reply.\n[wat"),
            "Visible reply.",
        )
        self.assertEqual(
            visible_danmaku_stream_text("Visible reply.\n[watch:danmaku 00:30"),
            "Visible reply.\n",
        )

    def test_parsed_intent_uses_the_same_action_validator_as_a_tool_call(self) -> None:
        core = WatchCore()
        session = core.create_session(
            session_id="watch_marker_test",
            media=MediaDescriptor(
                media_id="demo:movie",
                source="demo",
                title="Demo Movie",
                duration_ms=600_000,
            ),
            mode=SessionMode(knowledge_mode=KnowledgeMode.KNOWN),
            capabilities=ClientCapabilities(
                playback_snapshot=True,
                danmaku_overlay=True,
            ),
        )
        core.start_session(session.session_id)
        core.apply_snapshot(
            session.session_id,
            PlaybackSnapshot(
                media_id="demo:movie",
                playhead_ms=100_000,
                duration_ms=600_000,
                is_playing=True,
                playback_rate=1.0,
                timeline_epoch=0,
                snapshot_seq=1,
                captured_at="2026-01-01T00:00:00Z",
            ),
        )
        _visible, intents = split_danmaku_markers(
            "[watch:danmaku 02:10 That clue connects now.]"
        )

        action, validation = core.prepare_danmaku(
            session.session_id,
            target_ms=intents[0].target_ms,
            text=intents[0].text,
        )

        self.assertTrue(validation.valid)
        self.assertEqual(action.target_ms, 130_000)
        self.assertEqual(action.text, "That clue connects now.")


if __name__ == "__main__":
    unittest.main()
