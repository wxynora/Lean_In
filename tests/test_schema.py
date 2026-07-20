from __future__ import annotations

import json
import unittest
from pathlib import Path


class SchemaTest(unittest.TestCase):
    def test_protocol_schema_is_valid_json_and_contains_public_contracts(self) -> None:
        root = Path(__file__).resolve().parents[1]
        schema = json.loads((root / "schema" / "watch-v1.schema.json").read_text())

        self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertIn("playbackSnapshot", schema["$defs"])
        self.assertIn("clientCapabilities", schema["$defs"])
        self.assertIn("analysisCost", schema["$defs"])
        self.assertIn("danmakuToolInput", schema["$defs"])


if __name__ == "__main__":
    unittest.main()
