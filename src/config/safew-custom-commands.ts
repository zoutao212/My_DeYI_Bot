export const SAFEW_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;

export type SafewCustomCommandInput = {
  command?: string | null;
  description?: string | null;
};

export type SafewCustomCommandIssue = {
  index: number;
  field: "command" | "description";
  message: string;
};

export function normalizeSafewCommandName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  return withoutSlash.trim().toLowerCase();
}

export function normalizeSafewCommandDescription(value: string): string {
  return value.trim();
}

export function resolveSafewCustomCommands(params: {
  commands?: SafewCustomCommandInput[] | null;
  reservedCommands?: Set<string>;
  checkReserved?: boolean;
  checkDuplicates?: boolean;
}): {
  commands: Array<{ command: string; description: string }>;
  issues: SafewCustomCommandIssue[];
} {
  const entries = Array.isArray(params.commands) ? params.commands : [];
  const reserved = params.reservedCommands ?? new Set<string>();
  const checkReserved = params.checkReserved !== false;
  const checkDuplicates = params.checkDuplicates !== false;
  const seen = new Set<string>();
  const resolved: Array<{ command: string; description: string }> = [];
  const issues: SafewCustomCommandIssue[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const normalized = normalizeSafewCommandName(String(entry?.command ?? ""));
    if (!normalized) {
      issues.push({
        index,
        field: "command",
        message: "Safew custom command is missing a command name.",
      });
      continue;
    }
    if (!SAFEW_COMMAND_NAME_PATTERN.test(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `Safew custom command "/${normalized}" is invalid (use a-z, 0-9, underscore; max 32 chars).`,
      });
      continue;
    }
    if (checkReserved && reserved.has(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `Safew custom command "/${normalized}" conflicts with a native command.`,
      });
      continue;
    }
    if (checkDuplicates && seen.has(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `Safew custom command "/${normalized}" is duplicated.`,
      });
      continue;
    }
    const description = normalizeSafewCommandDescription(String(entry?.description ?? ""));
    if (!description) {
      issues.push({
        index,
        field: "description",
        message: `Safew custom command "/${normalized}" is missing a description.`,
      });
      continue;
    }
    if (checkDuplicates) {
      seen.add(normalized);
    }
    resolved.push({ command: normalized, description });
  }

  return { commands: resolved, issues };
}
