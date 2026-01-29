# Project Structure

```
VirtualWorld/
├── 99_System/                    # Core system code
│   ├── server/                   # Flask web application
│   │   ├── app.py               # Main Flask app, all API routes
│   │   ├── cognito_api.py       # CognitoCore REST API blueprint
│   │   ├── archive_api.py       # Document archive API
│   │   ├── static/              # CSS, JS frontend assets
│   │   ├── templates/           # Jinja2 HTML templates
│   │   └── domains/auto_writer/ # Automated writing workflow engine
│   │
│   ├── cognito_core/            # Cognitive persistence system
│   │   ├── core/                # CognitiveCore main interface
│   │   ├── models/              # Data models (MemoryAtom, Synapse, Axiom)
│   │   ├── repositories/        # Database access layer
│   │   ├── engines/             # Processing engines (retrieval, context, decay)
│   │   ├── agents/              # LLM providers, web search
│   │   ├── db/                  # PostgreSQL & Redis managers
│   │   ├── schema/              # SQL schema files
│   │   ├── ingestion/           # Document parsers (PDF, code, text)
│   │   └── config.yaml          # System configuration
│   │
│   ├── domains/                 # Domain-specific logic
│   │   ├── novel/               # Novel writing domain
│   │   ├── code/                # Code analysis domain
│   │   └── style_memory/        # Aesthetic engine, style retrieval
│   │
│   ├── database/                # SQLite databases & schemas
│   ├── ai_factory/              # LLM adapter factory pattern
│   ├── tools/                   # CLI utilities (ingest, migrate)
│   ├── tests/                   # Test files
│   │
│   ├── soul_kernel.py           # Main simulation kernel
│   ├── domain_interface.py      # Abstract domain interface
│   ├── evolution.py             # Style genome evolution
│   ├── validator.py             # Content validation
│   └── llm_providers.yaml       # LLM provider configurations
│
├── World_Module/                # Content & world data
│   ├── Assistants/              # AI assistant persona definitions (.md)
│   ├── Characters/              # Character profiles
│   ├── Plot_Scripts/            # Plot/scene scripts
│   ├── World_Settings/          # World building documents
│   └── System_Prompts/          # System prompt templates
│
├── WorkTemp/                    # Temporary work files
└── *.bat                        # Windows startup scripts
```

## Key Entry Points

- `server/app.py` - Web server with all routes and API endpoints
- `soul_kernel.py` - Core simulation kernel (SoulKernel class)
- `cognito_core/core/cognitive_core.py` - CognitiveCore main interface

## Architectural Patterns

- **Domain Interface**: All domains implement `DomainInterface` (tick, get_context)
- **Repository Pattern**: Database access via repository classes in `cognito_core/repositories/`
- **Factory Pattern**: LLM providers via `ai_factory/factory.py`
- **Blueprint Pattern**: Flask blueprints for API organization

## Database Schema

所有表定义在 `cognito_core/schema/00_master_schema.sql`，这是唯一的 schema 文件。

### 设计原则：KV Store 优先

对于小额配置数据（用户偏好、系统设置、功能开关等），**优先使用 `kv_store` 表**，而不是新建专用表。

```
kv_store 表结构：
- namespace: 命名空间（user_cognition, self_cognition, language_style, app_config...）
- scope: 作用域（user_id, session_id, 'default', 'global'）
- key: 键名
- value: JSONB 值
- metadata: 元数据（version, confidence 等）
```

**什么时候用 kv_store：**
- 数据量小（< 1000 条）
- 键值对结构
- 不需要复杂查询
- 配置类数据

**什么时候建专用表：**
- 数据量大（> 10000 条）
- 需要向量搜索（embedding）
- 需要复杂的关联查询
- 需要特殊索引

### 核心表（6个）
| 表名 | 说明 |
|------|------|
| `memory_atoms` | 记忆原子（核心存储单元） |
| `core_memories` | 核心记忆（重要的持久记忆） |
| `text_chunks` | 文本分块（文档切片） |
| `document_archives` | 文档存档（上传的文档元数据） |
| `synapses` | 突触连接（原子间关系） |
| `axioms` | 公理（不可变的核心规则） |

### 通用存储表
| 表名 | 说明 |
|------|------|
| `kv_store` | **通用键值存储**（小额配置数据首选） |

### 认知系统表（9个，可选）
这些表保留用于复杂场景，简单场景建议用 kv_store：

| 表名 | 说明 | 建议 |
|------|------|------|
| `user_cognitions` | 用户认知 | 可用 kv_store 替代 |
| `self_cognitions` | 自我认知 | 可用 kv_store 替代 |
| `language_styles` | 语言风格 | 可用 kv_store 替代 |
| `personas` | AI 人格定义 | 保留（需要 embedding） |
| `persona_modifications` | 人格修改历史 | 保留（需要历史追溯） |
| `session_personas` | 会话人格关联 | 可用 kv_store 替代 |

### 数据库维护命令
```bash
# 添加 kv_store 表（推荐）
python cognito_core/add_kv_store.py

# 安全添加认知表（如果需要）
python cognito_core/add_cognition_tables.py

# 完全重建数据库（会清空所有数据！）
python cognito_core/rebuild_database.py
```
