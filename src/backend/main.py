from contextlib import asynccontextmanager
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from threading import Lock
import re
import time
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from src.backend.knowledge.service import KnowledgeService
from src.backend.context.powercontext import PowerContextService
from src.backend.context.runtime import create_embedded_powercontext_app
from src.backend.papers.service import PaperImportError, delete_paper, index_pdf
from src.backend.vector.config import VectorSettings
from src.backend.vector.service import PaperVectorService, VectorServiceError
from src.backend.conversations import ConversationStoreError, load_conversations, save_conversations


_powercontext_settings = VectorSettings.from_environment()
_powercontext_app = create_embedded_powercontext_app(_powercontext_settings)
_powercontext_service = PowerContextService(_powercontext_app, _powercontext_settings)


def ensure_runtime_directories() -> None:
    data_root = Path(__file__).resolve().parents[2] / "data"
    for directory in (
        data_root,
        _powercontext_settings.paper_root,
        _powercontext_settings.state_file.parent,
        _powercontext_settings.seekdb_dir,
        _powercontext_settings.powercontext_dir,
        data_root / "conversations",
    ):
        directory.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # PowerContext's child application owns its embedded SeekDB and scheduler;
    # nesting its lifespan keeps both within this single backend process.
    ensure_runtime_directories()
    async with _powercontext_app.router.lifespan_context(_powercontext_app):
        app.state.powercontext = _powercontext_service
        yield


app = FastAPI(title="PaperBox 论文管理后端", version="0.1.0", lifespan=lifespan)

_vector_service: PaperVectorService | None = None
_vector_service_lock = Lock()
_paper_import_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="paper-index")
_paper_import_jobs: dict[str, dict] = {}
_paper_import_futures: dict[str, Future] = {}
_paper_import_jobs_lock = Lock()

def vector_service() -> PaperVectorService:
    """Lazily create the one embedded SeekDB instance for this API process."""
    global _vector_service
    with _vector_service_lock:
        if _vector_service is None:
            try:
                _vector_service = PaperVectorService()
            except Exception as error:
                raise VectorServiceError(f"SeekDB 初始化失败：{error}") from error
        return _vector_service


def powercontext_service() -> PowerContextService:
    return _powercontext_service


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    limit: int = Field(default=10, ge=1, le=100)
    categories: list[str] | None = None
    books: list[str] | None = None
    chapters: list[str] | None = None


class KnowledgeRetrieveRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    limit: int = Field(default=12, ge=1, le=20)
    previous_questions: list[str] = Field(default_factory=list, max_length=6)


class ConversationSaveRequest(BaseModel):
    conversations: list[dict] = Field(default_factory=list, max_length=500)


def _safe_paper_stem(filename: str) -> str:
    stem = Path(filename).stem
    safe = re.sub(r"[^\w.-]+", "_", stem, flags=re.UNICODE).strip("._")
    return safe[:100] or "未命名论文"


def _paper_response(
    path: Path,
    root: Path,
    *,
    title: str,
    processing: bool,
    preview: str,
    job_id: str | None = None,
    metadata: dict | None = None,
) -> dict:
    project_root = Path(__file__).resolve().parents[2]
    source_path = path.relative_to(project_root).as_posix()
    hierarchy = metadata.get("hierarchy") if isinstance(metadata, dict) and isinstance(metadata.get("hierarchy"), dict) else {}
    category = str(hierarchy.get("secondaryResearchField") or (metadata or {}).get("researchArea") or "待分类").strip()
    response = {
        "id": path.relative_to(root).parent.as_posix(), "title": title, "category": category,
        "preview": preview, "sourcePath": path.parent.relative_to(project_root).as_posix(),
        "pdfPath": source_path, "chapters": [{"title": "论文 PDF", "sourcePath": source_path}],
        "markdownCount": 0, "imageCount": 0, "modifiedAt": path.stat().st_mtime_ns,
        "processing": processing, "jobId": job_id,
    }
    if metadata:
        response.update({key: metadata[key] for key in ("author", "researchArea", "tags", "abstract", "summary", "classification", "hierarchy", "methodName", "methodAbbreviation", "paperNodeName", "venue", "year") if key in metadata})
    return response


def _index_imported_paper(job_id: str, path: Path, root: Path) -> None:
    with _paper_import_jobs_lock:
        if _paper_import_jobs[job_id].get("cancelRequested"):
            _paper_import_jobs[job_id].update({"state": "cancelled", "stage": "已停止", "finishedAt": time.time()})
            return
        _paper_import_jobs[job_id]["state"] = "processing"
        _paper_import_jobs[job_id]["stage"] = "正在准备处理"
        _paper_import_jobs[job_id]["startedAt"] = time.time()
        title = _paper_import_jobs[job_id]["title"]

    def update_stage(stage: str) -> None:
        with _paper_import_jobs_lock:
            _paper_import_jobs[job_id]["stage"] = stage

    def cancel_requested() -> bool:
        with _paper_import_jobs_lock:
            return bool(_paper_import_jobs[job_id].get("cancelRequested"))

    try:
        result = index_pdf(
            path,
            root,
            vector_service(),
            powercontext_service(),
            title=title,
            progress=update_stage,
            cancelled=cancel_requested,
        )
        paper = _paper_response(
            path,
            root,
            title=title,
            processing=False,
            preview=f"已解析 {result['pages']} 页，已建立 {result['index'].get('chunks_indexed', 0)} 个向量块。",
            metadata=result.get("metadata"),
        )
        with _paper_import_jobs_lock:
            _paper_import_jobs[job_id].update({"state": "completed", "stage": "处理完成", "finishedAt": time.time(), "paper": paper, **result})
    except Exception as error:
        with _paper_import_jobs_lock:
            if _paper_import_jobs[job_id].get("cancelRequested"):
                _paper_import_jobs[job_id].update({"state": "cancelled", "stage": "已停止", "finishedAt": time.time()})
            else:
                _paper_import_jobs[job_id].update({"state": "failed", "stage": "处理失败", "finishedAt": time.time(), "error": str(error)})


@app.post("/api/papers/import", status_code=201)
def import_paper(file: UploadFile = File(...)) -> dict:
    original_name = Path(file.filename or "").name
    if not original_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=422, detail="只能导入 PDF 文件。")
    content = file.file.read()
    if not content or len(content) > 100 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="单个 PDF 必须介于 1 B 和 100 MB 之间。")
    title = Path(original_name).stem.strip()[:200] or "未命名论文"
    stem = _safe_paper_stem(original_name)
    root = Path(__file__).resolve().parents[2] / "data" / "papers"
    folder = root / "5_导入论文" / f"{int(time.time() * 1000)}_{uuid4().hex[:8]}_{stem}"
    path = folder / f"{stem}.pdf"
    try:
        folder.mkdir(parents=True, exist_ok=False)
        path.write_bytes(content)
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"论文保存失败：{error}") from error
    job_id = uuid4().hex
    with _paper_import_jobs_lock:
        _paper_import_jobs[job_id] = {
            "id": job_id,
            "type": "论文导入",
            "state": "queued",
            "stage": "等待后台队列",
            "path": path.relative_to(root).as_posix(),
            "title": title,
            "createdAt": time.time(),
            "cancelRequested": False,
        }
    future = _paper_import_executor.submit(_index_imported_paper, job_id, path, root)
    with _paper_import_jobs_lock:
        _paper_import_futures[job_id] = future
    return {
        "paper": _paper_response(
            path,
            root,
            title=title,
            processing=True,
            preview="正在解析论文并建立索引。",
            job_id=job_id,
        ),
        "job": {"id": job_id, "state": "queued"},
    }


@app.get("/api/papers/imports/{job_id}")
def get_paper_import(job_id: str) -> dict:
    with _paper_import_jobs_lock:
        job = _paper_import_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="未找到导入任务。")
        return dict(job)


@app.delete("/api/papers/{paper_id:path}")
def remove_paper(paper_id: str) -> dict:
    root = Path(__file__).resolve().parents[2] / "data" / "papers"
    target = (root / paper_id).resolve()
    try:
        relative = target.relative_to(root.resolve())
    except ValueError as error:
        raise HTTPException(status_code=422, detail="论文路径无效。") from error
    if len(relative.parts) != 2:
        raise HTTPException(status_code=422, detail="只能删除论文目录。")
    with _paper_import_jobs_lock:
        active = next((
            job for job in _paper_import_jobs.values()
            if Path(str(job.get("path", ""))).parent.as_posix() == relative.as_posix()
            and job.get("state") in {"queued", "processing", "cancelling"}
        ), None)
    if active:
        raise HTTPException(status_code=409, detail="论文仍在后台处理中，请先在任务队列停止该任务。")
    try:
        return delete_paper(target, root, vector_service(), powercontext_service())
    except (PaperImportError, VectorServiceError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/api/tasks")
def get_tasks() -> dict:
    with _paper_import_jobs_lock:
        tasks = sorted((dict(job) for job in _paper_import_jobs.values()), key=lambda job: job.get("createdAt", 0), reverse=True)
    return {"tasks": tasks}


@app.post("/api/tasks/{job_id}/cancel")
def cancel_task(job_id: str) -> dict:
    with _paper_import_jobs_lock:
        job = _paper_import_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="未找到后台任务。")
        if job["state"] in {"completed", "failed", "cancelled"}:
            return dict(job)
        job["cancelRequested"] = True
        future = _paper_import_futures.get(job_id)
        if job["state"] == "queued" and future and future.cancel():
            job.update({"state": "cancelled", "stage": "已停止", "finishedAt": time.time()})
        else:
            job.update({"state": "cancelling", "stage": "正在停止（将在当前步骤结束后生效）"})
        return dict(job)


@app.get("/api/conversations/{kind}")
def get_conversations(kind: str) -> dict:
    try:
        return {"conversations": load_conversations(kind)}
    except ConversationStoreError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.put("/api/conversations/{kind}")
def put_conversations(kind: str, request: ConversationSaveRequest) -> dict:
    try:
        return {"conversations": save_conversations(kind, request.conversations)}
    except ConversationStoreError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/vector/status")
def vector_status() -> dict:
    try:
        return vector_service().status()
    except VectorServiceError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/vector/schema")
def vector_schema() -> dict:
    try:
        return vector_service().schema()
    except VectorServiceError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/vector/filters")
def vector_filters(
    categories: list[str] | None = Query(default=None),
    books: list[str] | None = Query(default=None),
) -> dict:
    try:
        return vector_service().filters(categories=categories, books=books)
    except VectorServiceError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/api/vector/search")
def search_papers(request: SearchRequest) -> dict:
    try:
        return {
            "query": request.query,
            "results": vector_service().search(
                query=request.query,
                limit=request.limit,
                categories=request.categories,
                books=request.books,
                chapters=request.chapters,
            ),
        }
    except VectorServiceError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/api/knowledge/retrieve")
def retrieve_knowledge(request: KnowledgeRetrieveRequest) -> dict:
    """Prepare concept/entity analysis and cited RAG context for the LLM bridge."""
    try:
        if not request.question.strip():
            raise HTTPException(status_code=422, detail="问题不能为空。")
        if any(len(question) > 4000 for question in request.previous_questions):
            raise HTTPException(status_code=422, detail="历史问题超出允许长度。")
        return KnowledgeService(vector_service(), powercontext_service()).retrieve(
            request.question.strip(), request.limit, request.previous_questions
        )
    except VectorServiceError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
