# Memory (SuperAgentMemory) Plugin

Neural-network-style long-term memory for Clawdbot, powered by [SuperAgentMemory](https://github.com/your-repo/SuperAgentMemory).

## Features

- **Ripple Retrieval**: Multi-hop neural-network-inspired search that follows synapse connections to discover related memories
- **Auto Synapse Linking**: Newly stored memories automatically connect to semantically related ones (16 relation types)
- **Auto Evolution**: Background systems (synapse growth, pruning, reinforcement, clustering, etc.) continuously optimize the memory network
- **Auto-Recall**: Relevant memories are automatically injected into agent context before processing
- **Auto-Capture**: Important information from conversations is automatically extracted and stored
- **Graceful Degradation**: Server downtime doesn't affect the main bot — memory features silently degrade

## Prerequisites

1. **SuperAgentMemory server** running and accessible
2. **PostgreSQL** with pgvector extension (managed by SuperAgentMemory)
3. **LM Studio** or compatible embedding service (managed by SuperAgentMemory)

## Installation

### 1. Start SuperAgentMemory

```bash
# From the SuperAgentMemory project directory
cd E:\SuperAgentMemory
pip install -r requirements.txt
python scripts/init_db.py

# Option A: No authentication (development)
python scripts/run_server.py --host 0.0.0.0 --port 8080

# Option B: With API key (production)
export AGENT_MEMORY_API__API_KEY="your-secure-api-key"
python scripts/run_server.py --host 0.0.0.0 --port 8080
```

### 2. Install Plugin Dependencies

```bash
cd E:\myclawdbot
pnpm install
```

### 3. Configure the Plugin

Add to your `clawdbot.json`:

```json
{
  "plugins": {
    "memory-superagent": {
      "server": {
        "baseUrl": "http://localhost:8080",
        "apiKey": "${SUPERAGENT_MEMORY_API_KEY}"
      },
      "autoRecall": true,
      "autoCapture": true,
      "defaults": {
        "maxResults": 10,
        "maxDepth": 3
      }
    }
  }
}
```

### 4. Configure API Key (if authentication enabled)

**If SuperAgentMemory has no API key configured (default)**: Leave `apiKey` empty or omit it.

**If SuperAgentMemory has API key configured**: Set the same key in your environment:

```bash
# Option 1: Environment variable (recommended for production)
export SUPERAGENT_MEMORY_API_KEY="your-secure-api-key"

# Option 2: Direct in config (not recommended for production)
# "apiKey": "your-secure-api-key"
```

The API key must match what's configured in SuperAgentMemory:
- Environment variable: `AGENT_MEMORY_API__API_KEY`
- Config file: `config/system_config.yaml` → `api.api_key`
- CLI argument: `--api-key`

## Agent Tools

The plugin registers three Agent tools that are automatically injected into the LLM's toolcall system via `api.registerTool()`:

### `supermemory_store`

Save important information to long-term memory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Information to remember (max 5000 chars) |
| `importance` | number | No | Importance 0-1 (default: 0.7) |
| `tags` | string[] | No | Tags for categorization |

**Tool Description (visible to LLM)**:
> Save important information in SuperAgentMemory — a neural-network-style long-term memory system with ripple retrieval. Use for user preferences, important facts, decisions, or any information worth remembering long-term. Automatically deduplicates and creates synapse connections to related memories.

### `supermemory_recall`

Search memories using ripple retrieval.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `maxResults` | number | No | Max results (default: 10) |
| `maxDepth` | number | No | Ripple depth 1-5 (default: 3) |

**Tool Description (visible to LLM)**:
> Search through SuperAgentMemory using ripple retrieval — a neural-network-inspired search that follows synapse connections to discover related memories across multiple hops. Better than simple keyword search for finding contextually related information. Use when you need context about user preferences, past decisions, or previously discussed topics.

### `supermemory_forget`

Delete specific memories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `memoryId` | number | No | Direct delete by ID |
| `query` | string | No | Search for candidates first |

**Tool Description (visible to LLM)**:
> Delete specific memories from SuperAgentMemory. Provide a memoryId for direct deletion, or a query to find candidates first.

### How Tools Are Injected

1. Plugin registration calls `api.registerTool(storeTool, { name: "supermemory_store" })` etc.
2. The tool objects (with `name`, `label`, `description`, `parameters`, `execute`) are added to the plugin registry
3. `resolvePluginTools()` in `src/plugins/tools.ts` loads all plugin tools
4. The tools are automatically included in the toolcall system's tool list
5. The LLM receives tool descriptions and can invoke them as needed

**Note**: The tools are available to the LLM by default. No additional configuration is needed beyond enabling the plugin in `clawdbot.json`.

## CLI Commands

```bash
# Check server health
clawdbot supermemory health

# Search memories
clawdbot supermemory search "user preferences" --limit 5 --depth 2

# Store a memory
clawdbot supermemory store "User prefers dark mode" --importance 0.9 --tags "preference,ui"

# Show stats
clawdbot supermemory stats
```

## Architecture

```
Clawdbot Agent
    │
    ├── supermemory_store ──── HTTP POST /v1/memory/store ────┐
    ├── supermemory_recall ─── HTTP POST /v1/memory/retrieve ─┤
    ├── supermemory_forget ─── HTTP DELETE /v1/memory/{id} ───┤
    │                                                          │
    ├── [before_agent_start] auto-recall ──────────────────────┤
    └── [agent_end] auto-capture ─────────────────────────────┤
                                                               ▼
                                                    SuperAgentMemory
                                                    ┌─────────────────┐
                                                    │ FastAPI + Auth  │
                                                    ├─────────────────┤
                                                    │ Ripple Engine   │
                                                    │ Synapse Growth  │
                                                    │ Evolution       │
                                                    │ Deduplication   │
                                                    ├─────────────────┤
                                                    │ PostgreSQL      │
                                                    │ + pgvector      │
                                                    └─────────────────┘
```

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `server.baseUrl` | string | `http://localhost:8080` | SuperAgentMemory API URL |
| `server.apiKey` | string | *(required)* | API key (supports `${ENV_VAR}`) |
| `autoRecall` | boolean | `true` | Auto-inject memories before agent starts |
| `autoCapture` | boolean | `true` | Auto-capture info after agent ends |
| `defaults.maxResults` | number | `10` | Default max recall results (1-50) |
| `defaults.maxDepth` | number | `3` | Default ripple depth (1-5) |
| `defaults.importance` | number | `0.7` | Default importance for stored memories |
| `defaults.decayFactor` | number | `0.6` | Ripple strength decay per hop |
| `defaults.minStrength` | number | `0.3` | Minimum synapse strength threshold |

## Comparison with Built-in Memory

| Feature | Built-in (SQLite/LanceDB) | SuperAgentMemory |
|---------|--------------------------|-----------------|
| Local file indexing | ✅ | ❌ |
| Vector search | ✅ (sqlite-vec/LanceDB) | ✅ (pgvector HNSW) |
| Ripple retrieval | ❌ | ✅ (4-layer) |
| Synapse connections | ❌ | ✅ (16 types) |
| Auto evolution | ❌ | ✅ (6 subsystems) |
| Cross-agent memory | ❌ | ✅ |
| Session tree | ❌ | ✅ |
| Zero dependencies | ✅ | Requires PostgreSQL |

## File Structure

```
extensions/memory-superagent/
├── clawdbot.plugin.json   # Plugin metadata + config schema
├── index.ts               # Plugin entry (tools + hooks + CLI + service)
├── client.ts              # HTTP client (store/retrieve/get/update/delete)
├── config.ts              # Config types + validation + env var resolution
├── tools.ts               # Agent tool definitions (store/recall/forget)
├── capture.ts             # Auto-capture logic (triggers + category detection)
└── README.md              # This file
```
