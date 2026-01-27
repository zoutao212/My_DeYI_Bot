#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import readline from "node:readline";

const args = process.argv.slice(2);
const env = { ...process.env };
const cwd = process.cwd();
const pnpmCmd = "pnpm";
const useShell = process.platform === "win32";
const compiler = env.CLAWDBOT_TS_COMPILER === "tsgo" ? "tsgo" : "tsc";
const projectArgs = ["--project", "tsconfig.json"];

function runPostBuildSteps() {
  const steps = [
    ["--import", "tsx", "scripts/canvas-a2ui-copy.ts"],
    ["--import", "tsx", "scripts/copy-hook-metadata.ts"],
    ["--import", "tsx", "scripts/write-build-info.ts"],
  ];
  for (const stepArgs of steps) {
    const res = spawnSync(process.execPath, stepArgs, {
      cwd,
      env,
      stdio: "inherit",
    });
    if (res.status !== 0) {
      process.exit(res.status ?? 1);
    }
  }
}

const initialBuild = spawnSync(pnpmCmd, ["exec", compiler, ...projectArgs], {
  cwd,
  env,
  stdio: "inherit",
  shell: useShell,
});

if (initialBuild.status !== 0) {
  if (initialBuild.error) {
    // eslint-disable-next-line no-console
    console.error("[watch-node] initial build failed", initialBuild.error);
  }
  process.exit(initialBuild.status ?? 1);
}

runPostBuildSteps();

const watchArgs =
  compiler === "tsc"
    ? [...projectArgs, "--watch", "--preserveWatchOutput"]
    : [...projectArgs, "--watch"];

const compilerProcess = spawn(pnpmCmd, ["exec", compiler, ...watchArgs], {
  cwd,
  env,
  stdio: ["inherit", "pipe", "pipe"],
  shell: useShell,
});

let nodeProcess = null;
let sawStableWatchLine = false;
let restartTimer = null;

function scheduleNodeRestart() {
  if (!nodeProcess) return;
  if (restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!nodeProcess) return;
    // eslint-disable-next-line no-console
    console.error(`Restarting 'dist/entry.js ${args.join(" ")}'`);
    nodeProcess.kill("SIGTERM");
    nodeProcess = null;
    startNodeProcess();
  }, 200);
}

function startNodeProcess() {
  if (nodeProcess) return;
  nodeProcess = spawn(process.execPath, ["dist/entry.js", ...args], {
    cwd,
    env,
    stdio: "inherit",
  });

  nodeProcess.on("exit", (code, signal) => {
    if (signal || exiting) return;
    cleanup(code ?? 1);
  });
}

// 透传 tsc watch 输出，同时等待其进入稳定的 "Watching for file changes" 状态。
if (compilerProcess.stdout) {
  const rlOut = readline.createInterface({ input: compilerProcess.stdout });
  rlOut.on("line", (line) => {
    process.stdout.write(`${line}\n`);
    if (line.includes("Watching for file changes")) {
      if (!sawStableWatchLine) {
        sawStableWatchLine = true;
        startNodeProcess();
      } else {
        scheduleNodeRestart();
      }
    }
  });
}

if (compilerProcess.stderr) {
  const rlErr = readline.createInterface({ input: compilerProcess.stderr });
  rlErr.on("line", (line) => {
    process.stderr.write(`${line}\n`);
  });
}

// 兜底：如果 tsc 没输出预期标志（或被静默），最多等待 3 秒再启动 Node。
setTimeout(() => {
  startNodeProcess();
}, 3000);

let exiting = false;

function cleanup(code = 0) {
  if (exiting) return;
  exiting = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  nodeProcess?.kill("SIGTERM");
  compilerProcess.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));

compilerProcess.on("exit", (code) => {
  if (exiting) return;
  cleanup(code ?? 1);
});
