from __future__ import annotations

import json
import unittest

from together_watch import (
    StructuredResponseError,
    extract_structured_object,
    parse_openai_compatible_response,
)


class ProviderResponseTests(unittest.TestCase):
    def test_accepts_wrappers_blocks_and_structured_message_fields(self) -> None:
        expected = {"plot_chunks": [{"summary": "A door opens."}], "story_background": {}}
        raw = json.dumps(expected)
        trailing = raw[:-1] + ",}"
        wrapped = extract_structured_object(
            {"content": f"Example: {{}}\n```json\n{trailing}\n```\nDone."},
            required_fields={"plot_chunks", "story_background"},
        )
        blocked = extract_structured_object(
            {
                "content": [
                    {"type": "text", "text": raw[: len(raw) // 2]},
                    {"type": "text", "text": raw[len(raw) // 2 :]},
                ]
            },
            required_fields={"plot_chunks"},
        )
        parsed = extract_structured_object(
            {"content": "", "parsed": expected},
            required_fields={"plot_chunks"},
        )

        self.assertEqual(wrapped, expected)
        self.assertEqual(blocked, expected)
        self.assertEqual(parsed, expected)

    def test_rejects_truncated_json_and_preserves_reported_usage(self) -> None:
        response = {
            "model": "example-model",
            "choices": [{"message": {"content": '{"plot_chunks": [{"summary": "cut"}'}}],
            "usage": {
                "prompt_tokens": 120,
                "completion_tokens": 30,
                "cost": 0.002,
            },
        }

        with self.assertRaises(StructuredResponseError) as caught:
            parse_openai_compatible_response(response, required_fields={"plot_chunks"})

        self.assertEqual(caught.exception.code, "json_incomplete")
        self.assertEqual(caught.exception.usage["cost_usd"], 0.002)
        self.assertTrue(caught.exception.usage["cost_reported"])


if __name__ == "__main__":
    unittest.main()
