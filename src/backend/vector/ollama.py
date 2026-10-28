from __future__ import annotations

import httpx

from .config import VectorSettings


class OllamaEmbeddingError(RuntimeError):
    pass


class OllamaEmbeddingClient:
    def __init__(self, settings: VectorSettings) -> None:
        self.url = f"{settings.ollama_url}/api/embed"
        self.model = settings.embedding_model

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        try:
            response = httpx.post(
                self.url,
                json={"model": self.model, "input": texts, "truncate": False, "keep_alive": "15m"},
                timeout=120.0,
            )
            response.raise_for_status()
            embeddings = response.json().get("embeddings")
        except (httpx.HTTPError, ValueError) as error:
            raise OllamaEmbeddingError(f"Ollama 嵌入请求失败（{self.model}）：{error}") from error
        if not isinstance(embeddings, list) or len(embeddings) != len(texts) or not all(isinstance(vector, list) and vector for vector in embeddings):
            raise OllamaEmbeddingError("Ollama 未返回与输入文本一一对应的向量。")
        dimensions = len(embeddings[0])
        if any(len(vector) != dimensions for vector in embeddings):
            raise OllamaEmbeddingError("Ollama 返回的向量维度不一致。")
        return embeddings
