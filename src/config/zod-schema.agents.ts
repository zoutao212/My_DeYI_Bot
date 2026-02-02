import { z } from "zod";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";
import { MemoryServiceSchema, TranscribeAudioSchema } from "./zod-schema.core.js";

// Re-export MemoryServiceSchema for backward compatibility
export { MemoryServiceSchema };

// Dynamic Pipeline Schema
export const DynamicPipelineSchema = z
  .object({
    /** 是否启用动态管道。默认 false。 */
    enabled: z.boolean().optional(),
    /** 角色配置目录。默认 "clawd/characters"。 */
    charactersDir: z.string().optional(),
    /** 默认角色。默认 undefined（不使用角色）。 */
    defaultCharacter: z.string().optional(),
    /** 系统人格。默认 undefined（使用默认人格）。 */
    systemPersona: z.string().optional(),
  })
  .strict()
  .optional();

export const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
    dynamicPipeline: DynamicPipelineSchema,  // 🆕 新增动态管道配置
  })
  .strict()
  .optional();

export const BindingsSchema = z
  .array(
    z
      .object({
        agentId: z.string(),
        match: z
          .object({
            channel: z.string(),
            accountId: z.string().optional(),
            peer: z
              .object({
                kind: z.union([z.literal("dm"), z.literal("group"), z.literal("channel")]),
                id: z.string(),
              })
              .strict()
              .optional(),
            guildId: z.string().optional(),
            teamId: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
  )
  .optional();

export const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

export const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();

export const AudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .strict()
  .optional();
