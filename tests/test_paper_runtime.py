import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from src.backend.main import app
from src.backend.papers.service import _apply_taxonomy_updates, _validate_catalog_hierarchies


class PaperRuntimeTest(unittest.TestCase):
    def test_catalog_taxonomy_requires_shared_core_technologies(self):
        identifiers = {f"paper-{number}" for number in range(6)}
        shared_rows = [
            {"id": f"paper-{number}", "hierarchy": {
                "primaryResearchField": "数据库自然语言交互",
                "secondaryResearchField": "Text-to-SQL 生成" if number < 4 else "Text-to-SQL 评测",
                "coreTechnology": "结构化推理与搜索" if number < 2 else "检索与模式链接" if number < 4 else "评测与基准分析",
            }}
            for number in range(6)
        ]
        shared_rows[0]["hierarchy"]["coreTechnologies"] = ["结构化推理与搜索", "检索与模式链接"]
        shared_rows[0]["hierarchy"].pop("coreTechnology")
        normalized = _validate_catalog_hierarchies(shared_rows, identifiers)
        self.assertEqual(set(normalized), identifiers)
        self.assertEqual(normalized["paper-0"]["coreTechnologies"], ["结构化推理与搜索", "检索与模式链接"])

        paper_specific_rows = [
            {"id": f"paper-{number}", "hierarchy": {
                "primaryResearchField": "数据库自然语言交互",
                "secondaryResearchField": "Text-to-SQL 生成",
                "coreTechnology": f"论文专有方法 {number}",
            }}
            for number in range(6)
        ]
        with self.assertRaisesRegex(RuntimeError, "粒度过细|单篇论文"):
            _validate_catalog_hierarchies(paper_specific_rows, identifiers)

    def test_taxonomy_merge_rewrites_existing_paper_metadata(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "1_Text2SQL" / "first"
            second = root / "1_Text2SQL" / "second"
            first.mkdir(parents=True)
            second.mkdir(parents=True)
            first_metadata = {"hierarchy": {"primaryResearchField": "数据库系统", "secondaryResearchField": "Text-to-SQL", "coreTechnology": "基于 Prompt"}}
            second_metadata = {"hierarchy": {"primaryResearchField": "数据库", "secondaryResearchField": "Text-to-SQL", "coreTechnology": "基于Prompt"}}
            (first / ".paperbox.json").write_text(json.dumps(first_metadata, ensure_ascii=False), encoding="utf-8")
            (second / ".paperbox.json").write_text(json.dumps(second_metadata, ensure_ascii=False), encoding="utf-8")

            _apply_taxonomy_updates(root, [{"level": "一级研究领域", "action": "merge", "from": ["数据库系统"], "to": "数据库"}])

            updated = json.loads((first / ".paperbox.json").read_text(encoding="utf-8"))
            self.assertEqual(updated["hierarchy"]["primaryResearchField"], "数据库")
            self.assertEqual(updated["hierarchy"]["coreTechnology"], "基于 Prompt")

    def test_seeded_papers_are_searchable_and_retrievable(self):
        with TestClient(app) as client:
            status = client.get("/api/vector/status")
            self.assertEqual(status.status_code, 200)
            self.assertGreaterEqual(status.json()["rows"], 10)

            search = client.post("/api/vector/search", json={"query": "关系感知模式链接", "limit": 5})
            self.assertEqual(search.status_code, 200)
            self.assertTrue(search.json()["results"])
            self.assertTrue(any("1_Text2SQL" in item["source_path"] for item in search.json()["results"]))

            retrieval = client.post("/api/knowledge/retrieve", json={"question": "RAT-SQL 如何处理数据库模式链接？", "limit": 5})
            self.assertEqual(retrieval.status_code, 200)
            self.assertTrue(retrieval.json()["context"].strip())


if __name__ == "__main__":
    unittest.main()
