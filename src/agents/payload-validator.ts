/**
 * Payload format validator for LLM requests
 * Validates request payload before sending to prevent format errors
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/payload-validator");

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

/**
 * Validate OpenAI-compatible chat completions payload
 */
export function validateOpenAICompletionsPayload(payload: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!payload || typeof payload !== "object") {
    errors.push("Payload must be an object");
    return { valid: false, errors, warnings };
  }

  const p = payload as Record<string, unknown>;

  // Check required fields
  if (!p.model || typeof p.model !== "string") {
    errors.push("Missing or invalid 'model' field");
  }

  if (!Array.isArray(p.messages)) {
    errors.push("Missing or invalid 'messages' array");
  } else {
    // Validate messages array
    for (let i = 0; i < p.messages.length; i++) {
      const msg = p.messages[i];
      if (!msg || typeof msg !== "object") {
        errors.push(`messages[${i}]: must be an object`);
        continue;
      }

      const m = msg as Record<string, unknown>;
      
      // Check role
      if (!m.role || typeof m.role !== "string") {
        errors.push(`messages[${i}]: missing or invalid 'role' field`);
      }

      const role = String(m.role).toLowerCase();

      // Validate based on role
      if (role === "tool") {
        // Tool result message must have tool_call_id
        if (!m.tool_call_id || typeof m.tool_call_id !== "string") {
          errors.push(`messages[${i}]: role=tool requires 'tool_call_id' field`);
        }
        
        // Check for thought_signature (required by some providers like vectorengine)
        if (!m.thought_signature && !m.thoughtSignature) {
          warnings.push(`messages[${i}]: role=tool missing 'thought_signature' (may cause issues with vectorengine)`);
        }
      } else if (role === "assistant") {
        // Assistant message with tool_calls
        if (m.tool_calls && Array.isArray(m.tool_calls)) {
          for (let j = 0; j < m.tool_calls.length; j++) {
            const tc = m.tool_calls[j];
            if (!tc || typeof tc !== "object") {
              errors.push(`messages[${i}].tool_calls[${j}]: must be an object`);
              continue;
            }

            const toolCall = tc as Record<string, unknown>;
            
            if (!toolCall.id || typeof toolCall.id !== "string") {
              errors.push(`messages[${i}].tool_calls[${j}]: missing 'id' field`);
            }

            if (!toolCall.type || toolCall.type !== "function") {
              errors.push(`messages[${i}].tool_calls[${j}]: 'type' must be 'function'`);
            }

            if (!toolCall.function || typeof toolCall.function !== "object") {
              errors.push(`messages[${i}].tool_calls[${j}]: missing 'function' object`);
            } else {
              const fn = toolCall.function as Record<string, unknown>;
              if (!fn.name || typeof fn.name !== "string") {
                errors.push(`messages[${i}].tool_calls[${j}].function: missing 'name' field`);
              }
            }

            // Check for thought_signature
            if (!toolCall.thought_signature && !toolCall.thoughtSignature) {
              warnings.push(`messages[${i}].tool_calls[${j}]: missing 'thought_signature' (may cause issues with vectorengine)`);
            }
          }
        }
      }

      // Check content field
      if (role !== "tool" && !m.content && !m.tool_calls) {
        warnings.push(`messages[${i}]: message has no 'content' or 'tool_calls'`);
      }
    }
  }

  // Validate tools array if present
  if (p.tools !== undefined) {
    if (!Array.isArray(p.tools)) {
      errors.push("'tools' must be an array");
    } else {
      for (let i = 0; i < p.tools.length; i++) {
        const tool = p.tools[i];
        if (!tool || typeof tool !== "object") {
          errors.push(`tools[${i}]: must be an object`);
          continue;
        }

        const t = tool as Record<string, unknown>;
        
        if (t.type !== "function") {
          errors.push(`tools[${i}]: 'type' must be 'function'`);
        }

        if (!t.function || typeof t.function !== "object") {
          errors.push(`tools[${i}]: missing 'function' object`);
        } else {
          const fn = t.function as Record<string, unknown>;
          if (!fn.name || typeof fn.name !== "string") {
            errors.push(`tools[${i}].function: missing 'name' field`);
          }
          if (!fn.parameters || typeof fn.parameters !== "object") {
            errors.push(`tools[${i}].function: missing 'parameters' object`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate and log payload before sending to LLM
 */
export function validateAndLogPayload(params: {
  payload: unknown;
  provider?: string;
  modelApi?: string;
  runId?: string;
  sessionKey?: string;
}): ValidationResult {
  const modelApi = String(params.modelApi ?? "").toLowerCase();
  
  let result: ValidationResult;
  
  if (modelApi.includes("openai-completions") || modelApi.includes("chat")) {
    result = validateOpenAICompletionsPayload(params.payload);
  } else {
    // Unknown API, skip validation
    return { valid: true, errors: [], warnings: [] };
  }

  if (!result.valid || result.warnings.length > 0) {
    const logData = {
      runId: params.runId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      modelApi: params.modelApi,
      valid: result.valid,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
      errors: result.errors,
      warnings: result.warnings,
    };

    if (!result.valid) {
      log.error(`❌ Payload validation FAILED: ${JSON.stringify(logData)}`);
    } else if (result.warnings.length > 0) {
      log.warn(`⚠️  Payload validation warnings: ${JSON.stringify(logData)}`);
    }
  }

  return result;
}
