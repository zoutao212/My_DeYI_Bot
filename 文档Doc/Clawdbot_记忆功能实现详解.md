# Clawdbot 记忆功能实现详解（可迁移版）

> 目标：把 Clawdbot 的“记忆（Memory）能力”按工程实现拆开讲清楚，便于你把同样的能力迁移/升级到其他项目。
>
> 术语约定：本文讨论的是 Clawdbot 自身的“记忆检索系统”（磁盘上的 Markdown 记忆 + 可选的会话 transcript 记忆 + 向量/全文混合检索 + compaction 前的记忆落盘提醒）。

---

## 1. 总体架构：两层“记忆” + 一个“索引服务”

Clawdbot 的记忆体系可以拆成三块：

- **记忆源（Source of Truth）**：
  - `MEMORY.md`（可选，长期记忆）
  - `memory/*.md`（常用，按天/按主题的记忆日志）
  - （可选）**会话 transcript**（JSONL，会随着对话增长，实验功能）

- **索引存储（Index Store）**：
  - 一个 SQLite 文件（默认在用户状态目录下，按 `agentId` 分库）
  - 表结构包含：文件表、chunk 表、embedding cache 表、（可选）FTS5 虚表、（可选）sqlite-vec 向量表

- **运行时服务（Manager）**：
  - 负责监听记忆文件变更、增量索引、Embedding 生成、检索与结果融合、对外提供 `memory_search` / `memory_get` 工具。

核心实现目录：

- `src/memory/manager.ts`：**MemoryIndexManager**，索引/检索/同步的总控
- `src/memory/internal.ts`：记忆文件枚举、分块、hash、路径校验
- `src/memory/memory-schema.ts`：SQLite schema（meta/files/chunks/cache/fts）
- `src/memory/manager-search.ts`：向量检索 + 关键字检索（FTS5）
- `src/memory/hybrid.ts`：混合检索（BM25 + 向量）合并
- `src/memory/embeddings.ts`：Embedding Provider 选择（openai/gemini/local/auto + fallback）
- `src/memory/embeddings-openai.ts` / `src/memory/embeddings-gemini.ts`：远端 embedding
- `src/memory/batch-openai.ts` / `src/memory/batch-gemini.ts`：批处理 embedding（可选增强）
- `src/memory/sqlite-vec.ts`：sqlite-vec 扩展加载
- `src/agents/tools/memory-tool.ts`：对模型暴露 `memory_search` / `memory_get`
- `src/agents/memory-search.ts`：配置解析与默认值（MemorySearchConfig → ResolvedMemorySearchConfig）
- `src/auto-reply/reply/memory-flush.ts`：接近 compaction 时触发“写入记忆”的提醒策略
- `src/auto-reply/reply/agent-runner-memory.ts`：实际执行 memory flush turn（嵌入式 agent run）

---

## 2. 记忆源（Markdown）怎么组织与识别

### 2.1 记忆文件位置与允许范围

Clawdbot 将“可被记忆检索系统读取的文件”限制在 workspace 内的：

- `MEMORY.md`（或兼容别名 `memory.md`）
- `memory/` 目录下的任意 `*.md`

关键实现：`src/memory/internal.ts`

- `isMemoryPath(relPath)`：只允许 `MEMORY.md`/`memory.md` 或 `memory/` 下路径
- `listMemoryFiles(workspaceDir)`：
  - 优先收集 `MEMORY.md`、`memory.md`
  - 递归遍历 `memory/` 下所有 `.md`
  - 通过 `realpath` 去重（避免软链接重复）

这意味着：

- **“记忆的单一真相源（SSOT）在 Markdown 文件本身”**
- `memory_get` 工具也只能读这些路径，防止模型越界读取 workspace 的其他敏感文件

### 2.2 分块（Chunking）策略

为了做向量检索，需要把 Markdown 拆成多个 chunk。

实现：`src/memory/internal.ts` 的 `chunkMarkdown(content, chunking)`

- **单位是“字符/行”实现，但配置表面是“token”**：
  - `maxChars ≈ tokens * 4`
  - `overlapChars ≈ overlap * 4`
- 按行扫描，超过 `maxChars` 就 flush 一个 chunk
- flush 后保留尾部 overlap 字符量，作为下一块的前缀（减少边界信息丢失）
- 每个 chunk 记录：
  - `startLine` / `endLine`
  - `text`
  - `hash = sha256(text)`

这套做法的优点：

- 不需要 tokenizer（实现简单、稳定）
- 结果依旧能映射回“文件+行号范围”，便于定位

风险与注意点：

- token 与 char 的近似会误差较大，但对“索引召回”通常可接受
- 如果你的项目对 chunk 边界敏感（例如超长代码块），建议在迁移时把 chunk 算法换成更严格的 tokenizer 级切分

---

## 3. 索引存储：SQLite 表结构与向量加速

### 3.1 核心表结构（Schema）

实现：`src/memory/memory-schema.ts`

- `meta(key,value)`：保存索引元信息（例如 embedding provider/model、chunking 参数、dims 等）
- `files(path, source, hash, mtime, size)`：记录每个被索引文件的整体 hash 与元信息
- `chunks(id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)`：
  - `embedding` 字段存 JSON 字符串（用于 JS 兜底 cosine）
  - `model` 记录 embedding model（支持不同模型切换后重建）
- `embedding_cache(provider, model, provider_key, hash, embedding, dims, updated_at)`：
  - 用于缓存 chunk embedding，避免重复请求/重复计算
  - 主键 `(provider, model, provider_key, hash)`

可选：

- `chunks_fts`（FTS5 虚表）：当启用 hybrid search 时创建

### 3.2 sqlite-vec 向量表（可选加速）

在 `src/memory/manager.ts` 中，向量检索优先走 sqlite-vec（如果可用）。

实现：

- 加载扩展：`src/memory/sqlite-vec.ts` 的 `loadSqliteVecExtension()`
- 向量表：`CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[dims])`

行为特点：

- 启动时不强制加载，第一次需要时才 `ensureVectorReady()`（带 30 秒超时）
- 如果加载失败：
  - 标记为不可用（日志告警）
  - 自动回退到“把所有 chunk embedding 拉出后在 JS 内做 cosine”

这是一种典型的“性能增强可选件”设计：

- **有 sqlite-vec：快（数据库做最近邻）**
- **没有 sqlite-vec：还能用（JS cosine 兜底）**

---

## 4. Embedding 生成：openai / gemini / local / auto + fallback

### 4.1 Provider 抽象

接口定义：`src/memory/embeddings.ts`

```ts
type EmbeddingProvider = {
  id: string;
  model: string;
  embedQuery(text): Promise<number[]>;
  embedBatch(texts): Promise<number[][]>;
}
```

### 4.2 远端 provider

- OpenAI：`src/memory/embeddings-openai.ts`
  - `POST {baseUrl}/embeddings`
  - headers 默认从 `models.providers.openai` 和 `memorySearch.remote.headers` 合并
  - API key：优先 `memorySearch.remote.apiKey`，否则走 Clawdbot 的 `resolveApiKeyForProvider`

- Gemini：`src/memory/embeddings-gemini.ts`
  - `:embedContent`（query）与 `:batchEmbedContents`（batch）
  - key 在 header 的 `x-goog-api-key`
  - `remote.apiKey` 支持写 `GEMINI_API_KEY`/`GOOGLE_API_KEY` 作为“引用环境变量”的快捷方式
  - `baseUrl` 会做 normalize：如果传了 `/openai` 兼容路径会去掉

### 4.3 本地 provider（node-llama-cpp）

实现：`src/memory/embeddings.ts`

- 默认模型：`hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`
- lazy-load `node-llama-cpp`：只有选了 local 才会 import
- 如果 local 初始化失败，会抛出带“如何安装/修复 node-llama-cpp”的错误文本

### 4.4 auto 与 fallback

实现：`createEmbeddingProvider()`（`src/memory/embeddings.ts`）

- `provider=auto`：
  - 如果配置了本地模型路径且文件存在 → 尝试 local
  - 否则依次尝试 openai、gemini
  - 遇到“缺 API key”会收集错误继续尝试下一个

- 显式 provider 失败时：
  - 如果 `fallback != none` 且与 primary 不同 → 尝试 fallback
  - manager 会记录：`fallbackFrom` 与 `fallbackReason`
  - `memory_search` 工具返回时也会带上 fallback 信息（便于排障）

### 4.5 providerKey：用于区分“同 provider/model 不同鉴权/端点”

`src/memory/manager.ts` 的 `computeProviderKey()`：

- OpenAI：hash(baseUrl + model + headers（去掉 Authorization）)
- Gemini：hash(baseUrl + model + headers（去掉 x-goog-api-key/authorization）)

用途：

- embedding_cache 的主键包含 `provider_key`
- 这样同一个 chunk 文本 hash，在不同 endpoint/headers 下不会互相污染

---

## 5. 批处理 Embedding（远端索引加速，可选增强）

大规模索引时，逐条调用 embeddings API 可能很慢/很贵。

Clawdbot 对 OpenAI 与 Gemini 都实现了“批处理 indexing”能力：

- OpenAI：`src/memory/batch-openai.ts`
  - 上传 JSONL 到 `/files`
  - 创建 `/batches`
  - 轮询直到完成，下载 output file

- Gemini：`src/memory/batch-gemini.ts`
  - multipart upload JSONL
  - 调用 `:asyncBatchEmbedContent`
  - 轮询 batch 状态，下载 results file
  - 如果 404（说明该 baseUrl/model 不支持 asyncBatchEmbedContent）→ 抛出明确错误，manager 会记录 batch failure 并降级

`src/memory/manager.ts` 的批处理策略要点：

- `remote.batch.enabled` 默认 true
- 支持 `wait`（是否等待批处理完成）
- 支持 `concurrency` 并发提交多个 batch job
- 有失败计数 `BATCH_FAILURE_LIMIT=2`：超过阈值后会自动禁用 batch，回退到非 batch embedding

迁移建议：

- 如果你的项目早期规模不大，可以先不做 batch
- 如果要做 batch，务必做“失败自动降级”，否则生产环境会因为 provider 特性差异导致不可用

---

## 6. 检索：向量、全文、混合（Hybrid）

### 6.1 向量检索优先级

`src/memory/manager-search.ts` 的 `searchVector()`：

1) 若 sqlite-vec 可用：
   - SQL：`vec_distance_cosine(v.embedding, ?) AS dist`
   - `score = 1 - dist`

2) 否则：
   - 把候选 chunk 的 embedding JSON 解析出来
   - JS 内做 `cosineSimilarity(queryVec, chunk.embedding)`

### 6.2 关键词检索（FTS5 + bm25）

`src/memory/manager-search.ts` 的 `searchKeyword()`：

- 需要 `fts.enabled && fts.available`
- SQL：`bm25(chunks_fts) AS rank`，rank 越小越好
- 转换：`textScore = 1 / (1 + max(0, rank))`

### 6.3 混合检索（Hybrid Merge）

`src/memory/hybrid.ts`

- `buildFtsQuery(raw)`：
  - 只提取 `[A-Za-z0-9_]+` token
  - 变成 `"token1" AND "token2" ...`
  - 这意味着中文词在 FTS 查询里不占优势（依赖向量召回）

- `mergeHybridResults()`：
  - 以 chunk id 做 union
  - `finalScore = vectorWeight * vectorScore + textWeight * textScore`

默认权重来自配置解析：

- vector: 0.7
- text: 0.3

迁移建议：

- 如果你的记忆内容以中文为主，FTS 的贡献会变弱；你可以：
  - 继续依赖向量为主（保持 0.7/0.3 或更偏向量）
  - 或者升级 `buildFtsQuery` 让它支持中文分词（例如接入 jieba 或 ICU tokenizer）

---

## 7. 同步与增量：watch、interval、session transcripts

`src/memory/manager.ts` 支持三类触发：

- **watch**：监听 workspace 下的 `MEMORY.md` 与 `memory/` 目录（chokidar）
  - `watchDebounceMs` 默认 1500ms

- **onSearch/onSessionStart**：
  - 搜索时如果 `dirty`，会异步触发 `sync()`（不阻塞 search 结果返回的路径设计）

- **interval**：
  - 可配置定时同步（默认 0 分钟 = 关闭）

### 7.1 session transcript（实验）

- 配置开关：`agents.defaults.memorySearch.experimental.sessionMemory`
- sources 里写了 `sessions` 才会索引
- 通过 `onSessionTranscriptUpdate()` 收到 session 文件更新事件
- 使用 delta 阈值（bytes/messages）进行增量 reindex，避免每条消息都触发

迁移建议：

- 你的项目若也有 session 日志（JSONL），可以照这套做：
  - “事件通知 + 阈值防抖 + 增量读取”
  - 但务必做访问控制：谁能读 sessions、是否可能泄露敏感信息

---

## 8. 工具层：memory_search / memory_get 如何暴露给模型

实现：`src/agents/tools/memory-tool.ts`

- `createMemorySearchTool()`：
  - tool name：`memory_search`
  - 参数：`query/maxResults/minScore`
  - 内部调用 `getMemorySearchManager()` → `manager.search()`
  - 返回：`results` + `provider/model/fallback`

- `createMemoryGetTool()`：
  - tool name：`memory_get`
  - 参数：`path/from/lines`
  - 内部调用 `manager.readFile()`
  - **路径必须是 `MEMORY.md` 或 `memory/*.md`**（由 manager 内的 isMemoryPath 限制）

关键设计点：

- 先 `memory_search`（返回片段+行号）
- 再 `memory_get`（只拉取必要范围，节省上下文）

这是一套“强制 recall → 精确读取”的经典模式，迁移价值很高。

---

## 9. compaction 前的“记忆落盘提醒”（Memory Flush）

这是 Clawdbot 的另一个关键点：

- “模型的上下文要被压缩（compaction）前”，系统会触发一次**静默的 agentic turn**，让模型把值得长期保留的东西写入 `memory/YYYY-MM-DD.md`。

实现：

- 规则与阈值：`src/auto-reply/reply/memory-flush.ts`
  - 默认 softThresholdTokens = 4000
  - 触发条件：`totalTokens >= contextWindow - reserveTokensFloor - softThresholdTokens`
  - 并且：同一次 compactionCount 只触发一次（通过 sessionEntry 的 `memoryFlushCompactionCount` 记录）

- 执行：`src/auto-reply/reply/agent-runner-memory.ts` 的 `runMemoryFlushIfNeeded()`
  - 会检查 sandbox workspace 是否可写（只读则跳过）
  - 会启动一次嵌入式 agent run，prompt 是 memoryFlush.prompt
  - flush 结束后更新 session store 里的 `memoryFlushAt` 与 `memoryFlushCompactionCount`

迁移建议：

- 如果你的系统也有“会话自动总结/压缩”，强烈建议加这一步：
  - compaction 发生前把“可复用信息”固化到磁盘/数据库
  - 并且默认应当静默（不打扰用户），只在必要时输出

---

## 10. 配置入口：MemorySearchConfig（可迁移配置清单）

配置类型定义：`src/config/types.tools.ts`（`MemorySearchConfig`）

支持：

- provider：openai/gemini/local
- remote：baseUrl/apiKey/headers + batch
- fallback：openai/gemini/local/none
- store：sqlite path + vector extensionPath
- chunking：tokens/overlap
- sync：watch/onSearch/onSessionStart/interval + sessions delta
- query：maxResults/minScore + hybrid 权重
- cache：embedding cache 开关/上限

解析与默认值：`src/agents/memory-search.ts`

- 默认 store：`<stateDir>/memory/{agentId}.sqlite`
- 默认 chunk：400 tokens，overlap 80
- 默认 maxResults：6，minScore 0.35
- 默认 hybrid：enabled，权重 0.7/0.3，candidateMultiplier 4

---

## 11. 迁移到其他项目：三种方案（保守/平衡/激进）

### 方案 A（保守）：只做 Markdown 记忆 + 简单向量检索

- **记忆源**：`MEMORY.md` + `memory/*.md`
- **索引**：SQLite（只要 chunks + embedding JSON 存储即可）
- **检索**：JS cosine（不引入 sqlite-vec、不引入 FTS5）
- **Embedding**：只接一个 provider（例如 OpenAI）

优点：实现最小、稳定。
缺点：性能一般、关键词精确检索弱。

### 方案 B（平衡，推荐）：Clawdbot 同级能力（最像本文）

- 向量：sqlite-vec 可用就用，不可用就 JS 兜底
- 全文：FTS5 + BM25
- 混合：0.7/0.3 加权
- Embedding：openai/gemini/local + fallback
- 增量：watch + onSearch 触发 sync
- compaction 前 flush：强烈建议加

优点：体验好、鲁棒、可扩展。
缺点：代码量中等，需要较好的工程化。

### 方案 C（激进）：升级为“结构化记忆”与“可追溯写入”

- 记忆不只写 Markdown，而是同时写结构化 JSON（例如：事实/偏好/决策/待办）
- 检索时先结构化过滤，再做向量召回
- 写入增加“来源证据”（链接到会话消息 id/时间）

优点：可控性更强、可审计。
缺点：实现复杂，需要产品化设计。

---

## 12. 验证与排障清单

- **验证索引文件是否生成**：检查 SQLite 文件是否存在（默认在 stateDir/memory/{agentId}.sqlite）
- **验证 sqlite-vec 是否可用**：看 manager.status().vector.available
- **验证 FTS 是否可用**：看 manager.status().fts.available
- **验证 fallback 是否发生**：memory_search 返回 payload 中的 `fallback`
- **验证 watch 是否触发**：修改 `memory/*.md` 后观察是否会触发 sync（需要运行时日志）
- **验证路径隔离**：memory_get 不能读取 `memory/` 之外的文件

---

## 13. 本仓库现状与建议

- `ProjectMemory/` 目录目前为空：
  - 它更像你“代码地图”体系的落地点，但在 clawdbot 这个仓库里还没沉淀。
- `文档Doc/` 当前只有 `使用文档.txt`，主要说明模板来源。

建议：

- 如果你要把“记忆实现细节”长期沉淀在这个仓库，本文档放在 `文档Doc/` 是合理的。
- 如果你要在本仓库内也引入“代码地图（ProjectMemory Gardening）”，需要单独建设 `ProjectMemory/00_索引/*` 这些入口文件（与本文的“记忆检索”是不同层）。

---

## 14. 关键文件速查（复制粘贴用）

- 记忆索引总控：`src/memory/manager.ts`
- 记忆文件枚举/分块：`src/memory/internal.ts`
- SQLite schema：`src/memory/memory-schema.ts`
- 向量/FTS 检索：`src/memory/manager-search.ts`
- Hybrid 合并：`src/memory/hybrid.ts`
- Embedding provider：`src/memory/embeddings.ts`
- OpenAI embeddings：`src/memory/embeddings-openai.ts`
- Gemini embeddings：`src/memory/embeddings-gemini.ts`
- OpenAI batch：`src/memory/batch-openai.ts`
- Gemini batch：`src/memory/batch-gemini.ts`
- sqlite-vec：`src/memory/sqlite-vec.ts`
- 配置解析：`src/agents/memory-search.ts`
- 工具暴露：`src/agents/tools/memory-tool.ts`
- compaction memory flush：`src/auto-reply/reply/memory-flush.ts`
- flush 执行器：`src/auto-reply/reply/agent-runner-memory.ts`
