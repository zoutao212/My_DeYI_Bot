# Tech Stack

## Languages
- Python 3.x (primary)
- SQL (PostgreSQL schemas)
- JavaScript (frontend)

## Backend Framework
- Flask (web server, API routes)
- FastAPI (CognitoCore async APIs)

## Databases
- PostgreSQL with pgvector extension (vector similarity search, main persistence)
- Redis (caching, async task queues)
- SQLite (local style memory, save files)

## AI/ML
- OpenAI-compatible LLM APIs (configurable via `llm_providers.yaml`)
- Sentence Transformers (local embeddings)
- Local LLM support via LM Studio (embedding generation)

## Key Libraries
```
# Core
flask, fastapi, uvicorn, pydantic
asyncpg, psycopg2-binary, pgvector, redis, aioredis

# AI/Embeddings
openai, anthropic, sentence-transformers
tiktoken, numpy

# Document Processing
PyPDF2, PyMuPDF, python-docx, markdown, beautifulsoup4

# Data
pandas, pyarrow, scikit-learn

# NLP (Chinese)
jieba, snownlp

# Async Tasks
celery[redis]
```

## Configuration Files
- `llm_providers.yaml` - LLM provider configurations with API keys (env vars)
- `cognito_core/config.yaml` - Database connections, retrieval settings, consciousness flow config

## Common Commands

```bash
# Start the web server
python server/app.py

# Or use batch files (Windows)
Start_Cognito.bat      # Start full system
Stop_Cognito.bat       # Stop services
Restart_Cognito.bat    # Restart

# Database operations
python cognito_core/add_kv_store.py       # 添加 KV 存储表（安全）
python cognito_core/add_cognition_tables.py  # 添加认知表（安全）
python cognito_core/rebuild_database.py   # 重建数据库（危险！会清空数据）

# Build style memory pool
python build_pool_unified.py --mode local --source "path/to/novels/" --output "pool.parquet"

# Install dependencies
pip install -r requirements.txt
pip install -r cognito_core/requirements.txt
```

## Key Components

### KV Store（通用键值存储）
用于存储小额配置数据，避免频繁建表：
```python
from cognito_core.engines.kv_store import kv_get, kv_set

# 存储
await kv_set('namespace', 'scope', 'key', {'value': 'data'})

# 读取
data = await kv_get('namespace', 'scope', 'key')
```

预定义命名空间：
- `user_cognition` - 用户认知
- `self_cognition` - 自我认知
- `language_style` - 语言风格
- `app_config` - 应用配置
- `session_state` - 会话状态

## Environment Variables
API keys are referenced via `${VAR_NAME}` in YAML configs:
- `MINIMAX_API_KEY`, `MY_XAI_KEY`, `MY_openrouter_KEY`, `MY_YinLi_KEY`, etc.

## Ports
- Flask server: default 5000
- PostgreSQL: 5433 (non-standard)
- Redis: 6379
- Local LLM (LM Studio): 12345
