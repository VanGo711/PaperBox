import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.conversations import ConversationStoreError, load_conversations, save_conversations


class ConversationStoreTests(unittest.TestCase):
    def test_round_trip_and_kind_isolation(self):
        conversations = [{"id": "c1", "title": "测试", "updatedAt": "2026-01-01T00:00:00Z", "turns": []}]
        with tempfile.TemporaryDirectory() as temporary, patch("src.backend.conversations.STORE_ROOT", Path(temporary)):
            self.assertEqual(load_conversations("knowledge"), [])
            self.assertEqual(save_conversations("knowledge", conversations), conversations)
            self.assertEqual(load_conversations("knowledge"), conversations)
            self.assertEqual(load_conversations("design"), [])
            self.assertTrue((Path(temporary) / "knowledge.json").is_file())

    def test_rejects_invalid_entries_and_kinds(self):
        with self.assertRaises(ConversationStoreError):
            save_conversations("knowledge", [{"id": "missing-turns", "title": "x"}])
        with self.assertRaises(ConversationStoreError):
            load_conversations("unknown")
