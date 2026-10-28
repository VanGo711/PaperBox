from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from pypdf import PdfReader

from src.backend.context.powercontext import PowerContextService
from src.backend.vector.markdown import PaperChunk, _split_text
from src.backend.vector.service import PaperVectorService

HIERARCHY_FIELDS = ("primaryResearchField", "secondaryResearchField", "coreTechnology")


class PaperImportError(RuntimeError):
    pass


def extract_pdf_pages(path: Path) -> list[str]:
    try:
        return [(page.extract_text() or "").strip() for page in PdfReader(path).pages]
    except Exception as error:
        raise PaperImportError(f"PDF 解析失败：{error}") from error


def _compact_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _taxonomy_field(value: object) -> str:
    aliases = {
        "一级研究领域": "primaryResearchField",
        "二级研究领域": "secondaryResearchField",
        "核心技术": "coreTechnology",
    }
    normalized = _compact_text(str(value or ""))
    return aliases.get(normalized, normalized if normalized in HIERARCHY_FIELDS else "")


def _environment_value(key: str) -> str:
    """Read a process setting first, then the project .env file without a new runtime dependency."""
    value = os.getenv(key, "").strip()
    if value:
        return value
    env_file = Path(__file__).resolve().parents[3] / ".env"
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, candidate = line.split("=", 1)
            if name.strip() == key:
                return candidate.strip().strip("\"'")
    except OSError:
        pass
    return ""


def _abstract_from_pages(pages: list[str]) -> str:
    text = "\n".join(pages[:3])
    match = re.search(
        r"(?:^|\n)\s*(?:abstract|a\s*b\s*s\s*t\s*r\s*a\s*c\s*t|摘要)\s*[:：]?\s*(.+?)(?=\n\s*(?:\d+(?:\.\d+)*[.、\s]+|keywords?|index terms?|关键词)\b|\Z)",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return _compact_text(match.group(1))[:3_000] if match else ""


def _document_author(path: Path) -> str:
    try:
        author = PdfReader(path).metadata.author
    except Exception:
        author = None
    return _compact_text(str(author or ""))[:300] or "PDF 中未标注"


def _fallback_metadata(path: Path, pages: list[str], title: str) -> dict[str, Any]:
    abstract = _abstract_from_pages(pages)
    return {
        "title": title,
        "author": _document_author(path),
        "researchArea": "未分类",
        "tags": [],
        "classification": {"researchFields": [], "topics": [], "methods": [], "tasks": [], "datasets": [], "frameworks": []},
        "hierarchy": {"primaryResearchField": "", "secondaryResearchField": "", "coreTechnologies": []},
        "taxonomyUpdates": [],
        "methodName": "论文未提及",
        "methodAbbreviation": "",
        "venue": "",
        "year": "",
        "abstract": abstract or "PDF 中未提取到摘要。",
        "summary": abstract or "已完成 PDF 解析和向量索引；未从文本层提取到摘要。",
    }


def _parse_json_object(raw: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", raw):
        try:
            value, _ = decoder.raw_decode(raw[match.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("模型未返回有效 JSON 对象。")


def _available_text_model(client: httpx.Client, base_url: str, headers: dict[str, str]) -> str:
    configured = _environment_value("LLM_MODEL")
    if configured:
        return configured
    response = client.get(f"{base_url}/models", params={"page_no": 1, "page_size": 100}, headers=headers)
    response.raise_for_status()
    payload = response.json()
    raw_models = payload.get("output", {}).get("models") or payload.get("output", {}).get("data") or payload.get("data") or []
    model_ids = [str(item.get("model") or item.get("model_id") or item.get("id") or "").strip() for item in raw_models if isinstance(item, dict)]
    text_models = [model for model in model_ids if model and "qwen" in model.casefold() and not any(token in model.casefold() for token in ("vl", "audio", "embed", "coder"))]
    for preferred in ("qwen-plus", "qwen-max", "qwen-turbo"):
        if preferred in text_models:
            return preferred
    if text_models:
        return text_models[0]
    raise ValueError("LLM_URL 未返回可用的 Qwen 文本模型。")


def _taxonomy_context(root: Path) -> dict[str, list[str]]:
    values = {field: set() for field in HIERARCHY_FIELDS}
    for metadata_file in root.rglob(".paperbox.json"):
        try:
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        hierarchy = metadata.get("hierarchy") if isinstance(metadata, dict) else None
        if not isinstance(hierarchy, dict):
            continue
        for field in HIERARCHY_FIELDS:
            value = hierarchy.get("coreTechnologies") if field == "coreTechnology" else hierarchy.get(field)
            candidates = _core_technology_labels(value) if field == "coreTechnology" else [_taxonomy_label(value)]
            values[field].update(candidate for candidate in candidates if candidate)
    return {field: sorted(items)[:100] for field, items in values.items()}


def _apply_taxonomy_updates(root: Path, updates: list[dict[str, Any]]) -> None:
    replacements: dict[str, dict[str, str]] = {field: {} for field in HIERARCHY_FIELDS}
    for update in updates:
        field = _taxonomy_field(update.get("level"))
        target = update.get("to")
        sources = update.get("from")
        action = update.get("action")
        if field not in HIERARCHY_FIELDS or action not in {"rename", "merge"} or not isinstance(target, str) or not isinstance(sources, list):
            continue
        normalized_target = _compact_text(target)[:80]
        if not normalized_target:
            continue
        for source in sources:
            normalized_source = _compact_text(str(source))[:80]
            if normalized_source and normalized_source != normalized_target:
                replacements[field][normalized_source] = normalized_target
    if not any(replacements.values()):
        return
    for metadata_file in root.rglob(".paperbox.json"):
        try:
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        hierarchy = metadata.get("hierarchy") if isinstance(metadata, dict) else None
        if not isinstance(hierarchy, dict):
            continue
        changed = False
        for field, mapping in replacements.items():
            if field == "coreTechnology":
                if not mapping:
                    continue
                current = _core_technology_labels(hierarchy.get("coreTechnologies") or hierarchy.get("coreTechnology"))
                updated = list(dict.fromkeys(mapping.get(value, value) for value in current))
                if updated != current or "coreTechnology" in hierarchy:
                    hierarchy.pop("coreTechnology", None)
                    hierarchy["coreTechnologies"] = updated
                    changed = True
                continue
            value = hierarchy.get(field)
            if isinstance(value, str) and value in mapping:
                hierarchy[field] = mapping[value]
                changed = True
        if changed:
            _write_metadata_file(metadata_file, metadata)


def _taxonomy_label(value: object) -> str:
    label = _compact_text(str(value or ""))[:80]
    return "" if not label or "导入论文" in label or label.casefold() in {"imported papers", "imports"} else label


def _core_technology_labels(value: object) -> list[str]:
    raw_values = value if isinstance(value, list) else [value]
    return list(dict.fromkeys(label for item in raw_values if (label := _taxonomy_label(item))))[:5]


def _catalog_paper_node_names(rows: object) -> dict[str, str]:
    if not isinstance(rows, list):
        return {}
    names: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            continue
        value = _compact_text(str(row.get("paperNodeName") or ""))[:48]
        if value:
            names[row["id"]] = value
    return names


def _validate_catalog_hierarchies(rows: object, expected_ids: set[str]) -> dict[str, dict[str, Any]]:
    """Reject a catalog taxonomy that turns paper-specific details into categories."""
    if not isinstance(rows, list):
        raise PaperImportError("LLM 未返回论文分类列表。")

    mappings: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            raise PaperImportError("LLM 返回了无效的论文分类记录。")
        identifier = row["id"]
        hierarchy = row.get("hierarchy")
        if identifier not in expected_ids or identifier in mappings or not isinstance(hierarchy, dict):
            raise PaperImportError("LLM 返回的论文分类与当前论文目录不一致。")
        normalized = {
            "primaryResearchField": _taxonomy_label(hierarchy.get("primaryResearchField")),
            "secondaryResearchField": _taxonomy_label(hierarchy.get("secondaryResearchField")),
            "coreTechnologies": _core_technology_labels(hierarchy.get("coreTechnologies") or hierarchy.get("coreTechnology")),
        }
        if not normalized["primaryResearchField"] or not normalized["secondaryResearchField"] or not normalized["coreTechnologies"]:
            raise PaperImportError("LLM 返回了空分类标签，请重新执行论文分类。")
        mappings[identifier] = normalized

    if set(mappings) != expected_ids:
        raise PaperImportError("LLM 未覆盖全部论文，未写入不完整的分类结果。")

    total = len(mappings)
    values = list(mappings.values())
    primary_count = len({item["primaryResearchField"] for item in values})
    secondary_count = len({(item["primaryResearchField"], item["secondaryResearchField"]) for item in values})
    core_counts = Counter(core for item in values for core in item["coreTechnologies"])
    secondary_counts = Counter((item["primaryResearchField"], item["secondaryResearchField"]) for item in values)

    # Scale the limit with the collection, while requiring small corpora to
    # share categories instead of turning individual papers into nodes.
    max_primary = 1 if total <= 8 else min(3, max(2, (total + 7) // 8))
    max_secondary = max(2, min(6, (total + 2) // 3))
    max_core = max(3, min(7, (total + 1) // 2))
    if primary_count > max_primary or secondary_count > max_secondary or len(core_counts) > max_core:
        raise PaperImportError(
            "LLM 的分类粒度过细，未写入每篇论文独立成类的结果"
            f"（一级 {primary_count}/{max_primary}，二级 {secondary_count}/{max_secondary}，核心技术 {len(core_counts)}/{max_core}）。"
        )
    if total >= 6 and (sum(count == 1 for count in core_counts.values()) > 1 or sum(count == 1 for count in secondary_counts.values()) > 1):
        raise PaperImportError(
            "LLM 生成了过多单篇论文分类，请重新执行合并分类"
            f"（单篇二级方向 {sum(count == 1 for count in secondary_counts.values())}，单篇核心技术 {sum(count == 1 for count in core_counts.values())}）。"
        )
    return mappings


def _indexed_catalog_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Expand a compact LLM taxonomy so every paper can only select shared labels."""
    primary = _taxonomy_label(payload.get("primaryResearchField"))
    secondary = payload.get("secondaryResearchFields")
    core = payload.get("coreTechnologies")
    papers = payload.get("papers")
    if not primary or not isinstance(secondary, list) or not isinstance(core, list) or not isinstance(papers, list):
        raise PaperImportError("LLM 未返回可用于归并的分类标签表。")
    secondary_labels = [_taxonomy_label(value) for value in secondary]
    core_labels = [_taxonomy_label(value) for value in core]
    if not 2 <= len(secondary_labels) <= 4 or not 3 <= len(core_labels) <= 5:
        raise PaperImportError("LLM 返回的归并标签数量不符合约束。")
    if not all(secondary_labels) or not all(core_labels) or len(set(secondary_labels)) != len(secondary_labels) or len(set(core_labels)) != len(core_labels):
        raise PaperImportError("LLM 返回了无效或重复的归并标签。")
    rows: list[dict[str, Any]] = []
    for paper in papers:
        if not isinstance(paper, dict) or not isinstance(paper.get("id"), str):
            raise PaperImportError("LLM 返回了无效的论文归并记录。")
        secondary_index = paper.get("secondaryIndex")
        core_indices = paper.get("coreTechnologyIndices")
        if core_indices is None:
            core_indices = [paper.get("coreTechnologyIndex")]
        if isinstance(secondary_index, bool) or not isinstance(secondary_index, int) or not isinstance(core_indices, list) or not core_indices:
            raise PaperImportError("LLM 未使用分类标签索引。")
        if not 0 <= secondary_index < len(secondary_labels) or any(isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(core_labels) for index in core_indices):
            raise PaperImportError("LLM 返回的分类标签索引超出范围。")
        rows.append({
            "id": paper["id"],
            "hierarchy": {
                "primaryResearchField": primary,
                "secondaryResearchField": secondary_labels[secondary_index],
                "coreTechnologies": list(dict.fromkeys(core_labels[index] for index in core_indices)),
            },
        })
    return rows


def reclassify_paper_catalog(root: Path) -> dict[str, Any]:
    """Build one evidence-grounded taxonomy across all currently imported papers."""
    base_url = _environment_value("LLM_URL").rstrip("/")
    api_key = _environment_value("LLM_API_KEY")
    if not base_url or not api_key or api_key == "xxx":
        raise PaperImportError("未配置可用的 LLM，无法重建论文分类。")

    # Earlier asynchronous imports may have a PDF but no sidecar if the
    # process was interrupted. Make those papers classifiable before the
    # catalog-wide pass instead of exposing their storage folder as a label.
    recovered = 0
    for pdf_file in sorted(root.rglob("*.pdf")):
        metadata_file = pdf_file.parent / ".paperbox.json"
        if metadata_file.exists():
            continue
        try:
            pages = extract_pdf_pages(pdf_file)
            metadata = _fallback_metadata(pdf_file, pages, pdf_file.stem)
            _write_metadata_file(metadata_file, metadata)
            recovered += 1
        except Exception:
            # The final response still includes a fallback record when a PDF
            # has no extractable text or its LLM pass is temporarily absent.
            continue

    records: list[dict[str, Any]] = []
    files: dict[str, Path] = {}
    for number, metadata_file in enumerate(sorted(root.rglob(".paperbox.json")), start=1):
        try:
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            identifier = f"P{number:03d}"
        except (OSError, ValueError):
            continue
        if not isinstance(metadata, dict):
            continue
        classification = metadata.get("classification") if isinstance(metadata.get("classification"), dict) else {}
        records.append({
            "id": identifier,
            "title": _compact_text(str(metadata.get("title") or ""))[:240],
            "abstract": _compact_text(str(metadata.get("abstract") or ""))[:2200],
            "summary": _compact_text(str(metadata.get("summary") or ""))[:2600],
            "keywords": [str(item)[:80] for item in metadata.get("tags", []) if isinstance(item, str)][:10],
            "researchArea": _compact_text(str(metadata.get("researchArea") or ""))[:100],
            "topics": [str(item)[:80] for item in classification.get("topics", []) if isinstance(item, str)][:6],
            "methods": [str(item)[:80] for item in classification.get("methods", []) if isinstance(item, str)][:6],
        })
        files[identifier] = metadata_file
    if not records:
        return {"papers": 0, "updated": 0}

    prompt = """你是学术论文知识库管理员。仅依据每篇论文提供的题名、摘要、内容总结、关键词、主题和方法，先为整个论文集合建立共享、紧凑的分类体系，再映射每一篇论文。输出严格 JSON：
{"taxonomy":[{"primaryResearchField":"一级研究领域","secondaryResearchField":"二级研究领域","coreTechnologies":["该子方向下可复用的核心技术范式"]}],"papers":[{"id":"与输入完全一致","paperNodeName":"不超过 24 个汉字或 48 个字符的论文简称","hierarchy":{"primaryResearchField":"一级研究领域","secondaryResearchField":"二级研究领域","coreTechnologies":["可同时归属的共享技术范式"]}}]}
规则：层级严格为“一级研究领域 -> 二级研究领域 -> 论文节点 -> 核心技术”。必须先完成 taxonomy，再填写 papers；每篇输入论文必须恰好输出一次。一级领域是宽而稳定的学科方向；二级领域是可复用的研究任务或子方向；一篇论文可关联一到三个核心技术。核心技术必须描述论文在方法中实际采用的通用技术手段，而不是论文提出的方法名、系统名、缩写、贡献表述、独有流水线或实验设置。例如，原文明确使用时可归为“多 Agent 协作”“强化学习”“蒙特卡洛树搜索”“检索增强”“模式链接”“执行反馈”“提示工程”；这些只是命名粒度示例，不能无证据套用。所有分类标签应不超过 20 个汉字或 40 个字符。paperNodeName 只写一个直接、简短的论文简称：常规论文优先方法缩写或短方法名；综述论文使用“Survey for {主题}”形式；不附加出版平台、年份、作者、完整标题、括号或说明。
内容总结中的方法设计、关键模块、训练/推理过程和工具调用可用于提炼技术点，但应先合并为跨论文复用的范式：相同或相近技术必须使用统一名称归组，不要为每篇论文另造“核心技术”。若集合主题相近，应只使用一个一级研究领域；除非有明确的学科差异，否则最多两个。二级领域和核心技术都必须尽可能由至少两篇论文共享；整个集合中每个层级最多允许一个单篇论文的例外。优先复用完全一致的术语，避免近义标签并列。
绝不能使用“导入论文”、文件夹名、文件名编号、未分类、其他作为任何层级标签；不得固定为预定义技术枚举。无法由摘要和关键词支持时使用“论文未明确说明”，但仍需保持层级术语专业。不要输出 Markdown 或解释。\n\n论文证据：\n"""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    with httpx.Client(timeout=180) as client:
        model = _available_text_model(client, base_url, headers)
        response = client.post(
            f"{base_url}/services/aigc/text-generation/generation",
            headers=headers,
            json={
                "model": model,
                "input": {"messages": [{"role": "user", "content": prompt + json.dumps(records, ensure_ascii=False)}]},
                "parameters": {"result_format": "message", "max_tokens": 4_000, "temperature": 0.05, "enable_thinking": False},
            },
        )
        response.raise_for_status()
        payload = response.json()
    choice = (payload.get("output", {}).get("choices") or [{}])[0]
    content = choice.get("message", {}).get("content") or choice.get("text") or payload.get("output", {}).get("text") or ""
    if isinstance(content, list):
        content = "".join(str(item.get("text", "")) if isinstance(item, dict) else str(item) for item in content)
    rows = _parse_json_object(str(content)).get("papers")
    paper_node_names = _catalog_paper_node_names(rows)
    try:
        mappings = _validate_catalog_hierarchies(rows, set(files))
    except PaperImportError as validation_error:
        # A short second pass is more reliable than allowing an otherwise good
        # model response to retain paper-specific labels from its first draft.
        draft = rows if isinstance(rows, list) else []
        repair_records = [
            {
                "id": record["id"],
                "title": record["title"],
                "abstract": record["abstract"][:900],
                "summary": record["summary"][:1_200],
            }
            for record in records
        ]
        repair_prompt = """你正在修正一个论文集合的初始分类草案。初始草案未通过校验，原因是：""" + str(validation_error) + """。
请仅基于论文证据和初始草案，将相近领域、任务和技术合并为共享标签。输出严格 JSON：
{"primaryResearchField":"唯一的一级研究领域","secondaryResearchFields":["二级领域 A","二级领域 B"],"coreTechnologies":["共享核心技术 A","共享核心技术 B","共享核心技术 C"],"papers":[{"id":"P001","secondaryIndex":0,"coreTechnologyIndices":[1,2]}]}
所有输入 id 必须恰好出现一次。`secondaryIndex` 和 `coreTechnologyIndices` 从 0 开始，且只能引用上方标签数组；每篇论文可引用一到三个核心技术。当前论文集合主题相近，一级研究领域必须恰好一个；二级研究领域必须为 2 到 4 个；核心技术必须为 3 到 5 个。每一个二级研究领域和核心技术都必须至少覆盖两篇论文。核心技术只能描述论文实际采用的通用技术手段，例如多 Agent 协作、强化学习、蒙特卡洛树搜索、检索增强、模式链接、执行反馈、提示工程；禁止使用论文方法名、缩写、独有模块、具体流水线或单一算法细节。请把内容总结中的技术点进行语义合并后再命名节点，不要输出解释或 Markdown。

论文证据：
""" + json.dumps(repair_records, ensure_ascii=False) + """

初始草案：
""" + json.dumps(draft, ensure_ascii=False)
        with httpx.Client(timeout=180) as client:
            repair_response = client.post(
                f"{base_url}/services/aigc/text-generation/generation",
                headers=headers,
                json={
                    "model": model,
                    "input": {"messages": [{"role": "user", "content": repair_prompt}]},
                    "parameters": {"result_format": "message", "max_tokens": 3_000, "temperature": 0.0, "enable_thinking": False},
                },
            )
            repair_response.raise_for_status()
            repair_payload = repair_response.json()
        repair_choice = (repair_payload.get("output", {}).get("choices") or [{}])[0]
        repair_content = repair_choice.get("message", {}).get("content") or repair_choice.get("text") or repair_payload.get("output", {}).get("text") or ""
        if isinstance(repair_content, list):
            repair_content = "".join(str(item.get("text", "")) if isinstance(item, dict) else str(item) for item in repair_content)
        repair_rows = _indexed_catalog_rows(_parse_json_object(str(repair_content)))
        mappings = _validate_catalog_hierarchies(repair_rows, set(files))
    updated = 0
    for identifier, normalized in mappings.items():
        metadata_file = files[identifier]
        try:
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(metadata, dict):
            continue
        changed = False
        if metadata.get("hierarchy") != normalized:
            metadata["hierarchy"] = normalized
            changed = True
        paper_node_name = paper_node_names.get(identifier)
        if paper_node_name and metadata.get("paperNodeName") != paper_node_name:
            metadata["paperNodeName"] = paper_node_name
            changed = True
        if changed:
            _write_metadata_file(metadata_file, metadata)
            updated += 1
    return {"papers": len(records), "updated": updated, "recovered": recovered}


def _llm_metadata(pages: list[str], fallback: dict[str, Any], taxonomy: dict[str, list[str]]) -> dict[str, Any]:
    base_url = _environment_value("LLM_URL").rstrip("/")
    api_key = _environment_value("LLM_API_KEY")
    if not base_url or not api_key or api_key == "xxx":
        return fallback
    evidence = "\n\n".join(f"第 {number} 页\n{text}" for number, text in enumerate(pages, start=1) if text)[:60_000]
    if not evidence:
        return fallback
    prompt = """你是严谨的中文学术论文分析助手。仅依据给出的论文原文，不得编造。请输出严格 JSON，不要 Markdown 或解释，字段如下：
{
  "researchArea": "一个研究领域标签",
  "tags": ["3 到 8 个论文主题标签"],
  "classification": {"researchFields": ["研究领域"], "topics": ["主题方向"], "methods": ["论文方法"], "tasks": ["应用任务"], "datasets": ["数据集"], "frameworks": ["工具框架"]},
  "hierarchy": {"primaryResearchField": "一级研究领域", "secondaryResearchField": "二级研究领域", "coreTechnologies": ["一到三个论文适用的核心技术范式"]},
  "taxonomyUpdates": [{"level": "primaryResearchField、secondaryResearchField 或 coreTechnology", "action": "keep、add、rename 或 merge", "from": ["现有标签"], "to": "规范标签", "reason": "原文或现有标签依据"}],
  "methodName": "论文提出或使用的核心方法名称；未提及则为论文未提及",
  "methodAbbreviation": "核心方法缩写；没有明确缩写则为空字符串",
  "paperNodeName": "不超过 24 个汉字或 48 个字符的论文分类节点简称；优先方法缩写或简短方法名",
  "venue": "论文出版平台或会议期刊；未提及则为空字符串",
  "year": "四位出版年份；未提及则为空字符串",
  "summary": "中文内容总结"
}
层级必须严格为“一级研究领域 -> 二级研究领域 -> 论文节点 -> 核心技术”。一级和二级领域应采用稳定、可复用的学术术语。一篇论文可关联一到三个核心技术。核心技术必须基于论文的内容总结、方法设计、关键模块、训练/推理过程或工具调用，描述实际采用的通用技术手段，而不是论文提出的方法名、系统名、缩写、独有模块或贡献表述。原文有明确证据时，技术名称可使用如“多 Agent 协作”“强化学习”“蒙特卡洛树搜索”“检索增强”“模式链接”“执行反馈”“提示工程”等标准范式；不得无证据套用，近义技术必须合并。优先使用现有核心技术标签，只有确有明显学术边界且无法归并时才新增。paperNodeName 只写一个直接、简短的论文简称：常规论文优先明确的方法缩写或短方法名；综述论文使用“Survey for {主题}”形式；禁止附加出版平台、年份、作者、完整标题、括号或说明。不能使用固定枚举或存储目录名。没有原文依据时相应字段为空。先对照现有分类标签：同义或粒度不一致时才输出 rename 或 merge，不能仅因新论文而重命名不相干分类；没有变更时输出 keep 或 add。分类字段只保留论文明确支持的标签；无法确认的数组返回空数组。内容总结必须遵循论文精读的证据标准：覆盖研究动机、方法设计、明确贡献、实验设计/关键结果、局限或适用边界；论文未提及的信息写“论文未提及”，合理推断必须标记“合理推断”。总结使用 4 到 6 个短段落，总长度不超过 3000 字。\n\n现有分类标签：\n"""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    with httpx.Client(timeout=120) as client:
        model = _available_text_model(client, base_url, headers)
        response = client.post(
            f"{base_url}/services/aigc/text-generation/generation",
            headers=headers,
            json={
                "model": model,
                "input": {"messages": [{"role": "user", "content": f"{prompt}{json.dumps(taxonomy, ensure_ascii=False)}\n\n论文原文：\n{evidence}"}]},
                "parameters": {"result_format": "message", "max_tokens": 3_600, "temperature": 0.1, "enable_thinking": False},
            },
        )
        response.raise_for_status()
        payload = response.json()
    choice = (payload.get("output", {}).get("choices") or [{}])[0]
    content = choice.get("message", {}).get("content") or choice.get("text") or payload.get("output", {}).get("text") or ""
    if isinstance(content, list):
        content = "".join(str(item.get("text", "")) if isinstance(item, dict) else str(item) for item in content)
    parsed = _parse_json_object(str(content))
    tags = parsed.get("tags")
    result = dict(fallback)
    if isinstance(parsed.get("researchArea"), str) and parsed["researchArea"].strip():
        result["researchArea"] = _compact_text(parsed["researchArea"])[:100]
    if isinstance(tags, list):
        result["tags"] = list(dict.fromkeys(_compact_text(str(tag))[:60] for tag in tags if _compact_text(str(tag))))[:8]
    classification = parsed.get("classification")
    if isinstance(classification, dict):
        result["classification"] = {
            key: list(dict.fromkeys(_compact_text(str(value))[:80] for value in classification.get(key, []) if _compact_text(str(value))))[:8]
            if isinstance(classification.get(key), list) else []
            for key in ("researchFields", "topics", "methods", "tasks", "datasets", "frameworks")
        }
    hierarchy = parsed.get("hierarchy")
    if isinstance(hierarchy, dict):
        result["hierarchy"] = {
            "primaryResearchField": _compact_text(str(hierarchy.get("primaryResearchField") or ""))[:80],
            "secondaryResearchField": _compact_text(str(hierarchy.get("secondaryResearchField") or ""))[:80],
            "coreTechnologies": _core_technology_labels(hierarchy.get("coreTechnologies") or hierarchy.get("coreTechnology")),
        }
    updates = parsed.get("taxonomyUpdates")
    if isinstance(updates, list):
        result["taxonomyUpdates"] = [item for item in updates[:20] if isinstance(item, dict)]
    for key, limit in (("methodName", 240), ("methodAbbreviation", 80), ("paperNodeName", 48), ("venue", 160), ("year", 4)):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            compact = _compact_text(value)[:limit]
            if key != "year" or re.fullmatch(r"\d{4}", compact):
                result[key] = compact
    if isinstance(parsed.get("summary"), str) and parsed["summary"].strip():
        result["summary"] = str(parsed["summary"]).strip()[:12_000]
    return result


def _write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    _write_metadata_file(path.parent / ".paperbox.json", metadata)


def _write_metadata_file(target: Path, metadata: dict[str, Any]) -> None:
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)


def _check_cancelled(cancelled: Callable[[], bool] | None) -> None:
    if cancelled and cancelled():
        raise PaperImportError("导入任务已停止。")


def delete_paper(path: Path, root: Path, vectors: PaperVectorService, context: PowerContextService) -> dict[str, Any]:
    try:
        relative_directory = path.resolve().relative_to(root.resolve())
    except ValueError as error:
        raise PaperImportError("论文路径无效。") from error
    if len(relative_directory.parts) != 2 or not path.is_dir():
        raise PaperImportError("只能删除论文目录。")
    pdf_files = list(path.glob("*.pdf"))
    for pdf in pdf_files:
        vectors.delete_source(pdf.relative_to(root).as_posix())
        context.delete_document(pdf.relative_to(root).as_posix())
    try:
        shutil.rmtree(path)
    except OSError as error:
        raise PaperImportError(f"删除论文文件失败：{error}") from error
    return {"deleted": relative_directory.as_posix(), "vector_sources": len(pdf_files)}


def pdf_chunks(path: Path, root: Path, *, chunk_size: int, overlap: int) -> tuple[list[PaperChunk], list[str]]:
    pages = extract_pdf_pages(path)
    relative = path.relative_to(root).as_posix()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    parts = path.relative_to(root).parts
    category = parts[0] if parts else "未分类"
    book = path.stem
    chunks: list[PaperChunk] = []
    char_cursor = 0
    for page_number, page_text in enumerate(pages, start=1):
        page_start = char_cursor
        char_cursor += len(page_text) + 1
        for text in _split_text(page_text, chunk_size, overlap):
            start = page_text.find(text)
            start = max(0, start)
            end = start + len(text)
            index = len(chunks)
            identifier = hashlib.sha256(f"{relative}:{index}:{text}".encode("utf-8")).hexdigest()
            chunks.append(PaperChunk(identifier, f"第 {page_number} 页\n\n{text}", relative, category, book, f"第 {page_number} 页", f"第 {page_number} 页", page_number, page_number, page_start + start, page_start + end, index, digest))
    return chunks, pages


def index_pdf(
    path: Path,
    root: Path,
    vectors: PaperVectorService,
    context: PowerContextService,
    *,
    title: str,
    progress: Callable[[str], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> dict:
    if progress:
        progress("正在解析 PDF")
    chunks, pages = pdf_chunks(path, root, chunk_size=vectors.settings.chunk_size, overlap=vectors.settings.chunk_overlap)
    if not chunks:
        raise PaperImportError("PDF 中未提取到可检索文本；扫描件请先完成 OCR。")
    _check_cancelled(cancelled)
    if progress:
        progress("正在提取摘要并生成总结")
    metadata = _fallback_metadata(path, pages, title)
    llm_error = ""
    try:
        metadata = _llm_metadata(pages, metadata, _taxonomy_context(root))
    except Exception as error:
        llm_error = str(error)
    _check_cancelled(cancelled)
    _write_metadata(path, metadata)
    _apply_taxonomy_updates(root, metadata.get("taxonomyUpdates", []))
    if progress:
        progress("正在写入向量数据库")
    indexed = vectors.index_chunks(chunks)
    _check_cancelled(cancelled)
    source_path = path.relative_to(root).as_posix()
    if progress:
        progress("正在写入 PowerContext 上下文")
    captured = context.capture_document(
        source_path=source_path,
        title=title,
        content="\n\n".join(f"第 {number} 页\n{text}" for number, text in enumerate(pages, start=1) if text),
        metadata={"pages": len(pages), "chunks": len(chunks), "document_hash": chunks[0].document_hash},
    )
    _check_cancelled(cancelled)
    return {"index": indexed, "powercontext": captured, "pages": len(pages), "metadata": metadata, "llm_error": llm_error}
