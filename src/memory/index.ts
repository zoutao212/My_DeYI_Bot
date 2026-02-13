export type { MemoryIndexManager, MemorySearchResult } from "./manager.js";
export { getMemorySearchManager, type MemorySearchManagerResult } from "./search-manager.js";
// H5: 记忆生命周期管理
export {
  detectSimilarMemories,
  archiveStaleMemories,
  restoreFromArchive,
  listArchivedMemories,
  type ConflictEntry,
  type ArchiveResult,
} from "./memory-lifecycle.js";
