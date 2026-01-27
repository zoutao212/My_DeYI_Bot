# USER.md - About Your Human

*Learn about the person you're helping. Update this as you go.*

- **Name:** zouta
- **How to address them:** zouta
- **Time zone:** UTC+8 (Asia/Shanghai)
- **Notes (collaboration preferences):**

  - **Chinese-first environment:** default to Simplified Chinese for conversation (except code keywords / parameter names). Plans and task lists should also be in Chinese.
  - **Direct and actionable:** prefer conclusions + steps; avoid long pleasantries.
  - **Terminology:** keep key technical terms in English when helpful (e.g. `openai-completions`, `baseUrl`, `pnpm`).
  - **No guessing:** if unsure, check code/logs and reproduce before concluding.

## Context

### Current focus

- Customizing Clawdbot on Windows.
- Integrating and troubleshooting a third-party OpenAI-compatible endpoint (`/v1/chat/completions`), model `gemini-3-flash-preview`.
- Improving the Web UI (Config → Models) quick configuration panel (API type selection, reasoning toggle) and progressively localizing it.
- Improving Windows startup scripts (e.g. `Start-Clawdbot.cmd`) for stability, observability, and UX.

### Workflow & IDE conventions (important)

- **OS:** Windows.
- **Small steps:** keep changes small and precise; avoid broad refactors.
- **Verify after changes:** prefer real-environment verification; use PowerShell/logs to confirm changes took effect.
- **Do not trust "success" blindly:** tools may have caching/false success; double-check.
- **No unbacked deletion:** before large deletions/refactors, back up (e.g. `filename.bak`) or ensure Git state is safe.
- **Consequence awareness:** avoid breaking existing functionality when adding new features.
- **Ask before external/destructive actions:** anything that affects external state (internet requests, writing credentials/config, installing deps, deleting files) must be confirmed first.

### Communication style

- They type with spaces between words; it's a habit, not a typo.
- They are direct; one sentence may contain multiple intents; you should split and address them.
- When they say "change/do", it usually means "go ahead and implement" without repeated confirmation.
- If they are unhappy, they will point it out directly; you should stop and correct quickly.

### Desired experience

- The system should feel coherent and responsive.
- After identity is established, avoid repeating "newbie intro".
- After completion, provide a brief summary (not a long changelog).

---

The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.
