# 向量检索环境

本项目使用 **SeekDB** 作为运行时向量数据库。它由 Python 绑定启动为本地嵌入式实例，运行时数据保存在 `data/vector/seekdb/`，不需要 Docker 或独立数据库服务。论文块、向量和溯源字段保存在 `paper_chunks` 表中。

新 PDF 通过 `/api/papers/import` 导入：后端使用 `pypdf` 按页提取文本、写入 SeekDB，并在同一后端进程内将论文作为 Source/Memory 捕获到 PowerContext。PowerContext 使用 `data/powercontext/powercontext.db` 保存上下文工件，不会监听额外端口；问答时会先请求其有界上下文，再附加 SeekDB 命中的可引用原文块。

集合会配置 COSINE + HNSW 密集向量索引，以及分类、书籍、章节、源文件等字段的 INVERTED 标量索引，支持“标量筛选 + 向量检索”。默认嵌入模型为本机 Ollama 中已存在的 `qwen3-embedding:4b`，与生成模型分开使用。

## 准备环境

```bash
conda env create -f environment.yml
conda activate paper

npm run dev
```

根目录的 `npm run dev` 会同时启动前端（9100）与后端（9200）。如只需要后端，使用 `npm run dev:backend`。

服务启动时不会初始化 SeekDB、不会创建表、不会读取或插入论文数据。只有显式调用向量接口或导入论文时才会启动运行时数据库；其中仅索引接口和导入接口会写入向量数据。

## 后续显式索引与检索

```bash
# 首次建库或只增量更新发生改动的 Markdown
curl -X POST http://127.0.0.1:9200/api/vector/index \
  -H 'Content-Type: application/json' -d '{"rebuild": false}'

# 按标量字段筛选后进行语义检索
curl -X POST http://127.0.0.1:9200/api/vector/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"压水堆一回路的主要作用是什么？","categories":["1_系统介绍"],"limit":6}'
```

索引状态和数据库文件均位于 `data/vector/`，已经忽略 Git。每个成功向量化的 Markdown 块都保存来源、分类、书籍、章节、块序号和原文，因此知识问答模块可以将检索结果直接作为 RAG 上下文并展示可追溯来源。
