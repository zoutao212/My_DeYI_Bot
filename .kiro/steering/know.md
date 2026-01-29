# 项目知识与沟通规范

## 语言偏好
- 所有文档、计划、任务说明使用**中文**
- 代码注释可以使用中文或英文
- 变量名、函数名使用英文

## 项目环境配置

### 数据库
- PostgreSQL 端口: **5433**（非标准端口）
- PostgreSQL 密码: **989212**
- 使用 pgvector 扩展进行向量相似度搜索

### 嵌入服务
- LM Studio 本地嵌入服务: `http://127.0.0.1:12345/v1`
- 嵌入维度: **1024**（jina-embeddings-v3）
- LM Studio 会忽略 model 参数，使用当前加载的模型

### Redis
- 默认端口: 6379
- 用于缓存和异步任务队列

## 开发规范

### 代码修改
- 直接执行修改，不要只创建文件而不应用
- 修改后需要重启 Cognito 服务才能生效
- 使用 `Start_Cognito.bat` 或 `Restart_Cognito.bat` 重启服务

### LLM 记忆提取
- LLM 记忆提取是**可选功能**
- 系统应该优雅地回退到规则模式
- 不要因为 LLM 调用失败而阻塞主流程

### 记忆系统
- 记忆不仅需要创建，还需要支持**修改/更新**
- AI 应该能够在对话中动态修改自己的提示词/人格
- 这是类似于记忆可更新的核心需求

## 项目结构要点

### 核心目录
- `VirtualWorld/99_System/` - 核心系统代码
- `VirtualWorld/99_System/cognito_core/` - 认知持久化系统
- `VirtualWorld/99_System/server/` - Flask Web 应用
- `VirtualWorld/World_Module/Assistants/` - AI 助手人格定义

### 关键文件
- `cognito_core/config.yaml` - 系统配置
- `llm_providers.yaml` - LLM 提供商配置
- `server/cognito_api.py` - CognitoCore REST API
- `cognito_core/schema/00_master_schema.sql` - **唯一的数据库 schema 文件**

## 数据库维护规范

### 核心原则：KV Store 优先
- **小额配置数据优先使用 `kv_store` 表**
- 不要为了存几条数据就新建表
- `kv_store` 通过 namespace + scope + key 组织数据

### KV Store 使用示例
```python
from cognito_core.engines.kv_store import KVStore, kv_get, kv_set

# 存储用户偏好
await kv_set('user_cognition', 'user_123', 'preferences.language', '中文')

# 存储语言风格
await kv_set('language_style', 'default', 'settings', {
    'formality': 0.5, 'detail_level': 0.5
})

# 存储应用配置
await kv_set('app_config', 'global', 'feature_flags', {
    'enable_streaming': True
})
```

### 什么时候建专用表
- 数据量大（> 10000 条）
- 需要向量搜索（embedding）
- 需要复杂的关联查询

### Schema 管理原则
- **所有表定义必须在 `00_master_schema.sql` 中**
- 不要创建 fix_xxx.sql 补丁文件
- 新增表时，同时更新 `structure.md` 中的表结构文档

### 危险操作警告
- `rebuild_database.py` 会**删除所有数据**！
- 只在全新部署或确认可以丢失数据时使用
- 日常开发使用 `add_kv_store.py` 等安全脚本

## 常见问题解决

### 检索不到 text_chunks
1. 检查 `text_chunks` 表是否有 embedding
2. 确认 `config.yaml` 中 `enable_text_chunks: true`
3. 检查 `preview_chat_context` 是否使用正确的参数调用 `retrieve_for_chat()`

### 嵌入生成失败
1. 确认 LM Studio 正在运行
2. 检查端口 12345 是否可访问
3. 确认 `embedding.dimensions` 设置为 1024

### 数据库连接失败
1. 确认 PostgreSQL 服务正在运行
2. 检查端口 5433（非默认端口）
3. 验证密码 989212
