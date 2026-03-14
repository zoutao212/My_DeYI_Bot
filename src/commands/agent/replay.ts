import type { RuntimeEnv } from "../../runtime.js";
import { replayTaskEvents } from "../../agents/intelligent-task-decomposition/task-events-replay.js";
import { loadLoopLedgerEntries } from "../../agents/intelligent-task-decomposition/loop-ledger.js";

function formatTs(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return "";
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

function fmtJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export async function replayAgentRunReport(params: {
  sessionId: string;
  runtime: RuntimeEnv;
  maxEvents?: number;
  maxLedger?: number;
  json?: boolean;
}) {
  const { sessionId, runtime } = params;
  const maxEvents = typeof params.maxEvents === "number" ? Math.max(1, params.maxEvents) : 50;
  const maxLedger = typeof params.maxLedger === "number" ? Math.max(1, params.maxLedger) : 20;

  const jsonMode = params.json === true;

  const reportLines: string[] = [];
  reportLines.push(`# Agent Replay Report`);
  reportLines.push("");
  reportLines.push(`sessionId: ${sessionId}`);
  reportLines.push("");

  let eventsTail: any[] = [];
  let eventsErr: string | null = null;
  try {
    const replay = await replayTaskEvents(sessionId);
    const last = Array.isArray((replay as any).last) ? ((replay as any).last as any[]) : [];
    eventsTail = last.slice(-maxEvents);

    if (!jsonMode) {
      reportLines.push(`## task-events.jsonl (last ${eventsTail.length}/${maxEvents})`);
      reportLines.push("");
      if (eventsTail.length === 0) {
        reportLines.push("(no events)");
      } else {
        for (const e of eventsTail) {
          const ts = formatTs(typeof e?.ts === "number" ? e.ts : undefined);
          const type = String(e?.type ?? "unknown");
          const data = e?.data ? fmtJson(e.data) : "";
          reportLines.push(`- [${ts}] ${type}${data ? ` ${data}` : ""}`);
        }
      }
      reportLines.push("");
    }
  } catch (err) {
    eventsErr = String(err);
    if (!jsonMode) {
      reportLines.push(`## task-events.jsonl`);
      reportLines.push("");
      reportLines.push(`(failed to load events: ${String(err)})`);
      reportLines.push("");
    }
  }

  let ledgerTail: any[] = [];
  let ledgerErr: string | null = null;
  try {
    const ledger = await loadLoopLedgerEntries(sessionId);
    ledgerTail = ledger.slice(-maxLedger);

    if (!jsonMode) {
      reportLines.push(`## loop-ledger.json (last ${ledgerTail.length}/${maxLedger})`);
      reportLines.push("");
      if (ledgerTail.length === 0) {
        reportLines.push("(no ledger entries)");
      } else {
        for (const it of ledgerTail) {
          const ts = formatTs(it.ts);
          const phase = it.phase;
          const reason = it.reason ? ` reason=${it.reason}` : "";
          const nextAction = it.nextAction ? ` nextAction=${it.nextAction}` : "";
          reportLines.push(`- [${ts}] phase=${phase}${reason}${nextAction}`);
        }
      }
      reportLines.push("");
    }
  } catch (err) {
    ledgerErr = String(err);
    if (!jsonMode) {
      reportLines.push(`## loop-ledger.json`);
      reportLines.push("");
      reportLines.push(`(failed to load ledger: ${String(err)})`);
      reportLines.push("");
    }
  }

  if (jsonMode) {
    const payload = {
      sessionId,
      limits: { maxEvents, maxLedger },
      errors: { events: eventsErr, ledger: ledgerErr },
      events: eventsTail,
      ledger: ledgerTail,
    };
    runtime.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  const out = reportLines.join("\n").trimEnd();
  runtime.log(out);
  return { sessionId };
}
