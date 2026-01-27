#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

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
  for (const args of steps) {
    const res = spawnSync(process.execPath, args, {
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
  stdio: "inherit",
  shell: useShell,
});

const nodeProcess = spawn(process.execPath, ["--watch", "dist/entry.js", ...args], {
  cwd,
  env,
  stdio: "inherit",
});

let exiting = false;

function cleanup(code = 0) {
  if (exiting) return;
  exiting = true;
  nodeProcess.kill("SIGTERM");
  compilerProcess.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));

compilerProcess.on("exit", (code) => {
  if (exiting) return;
  cleanup(code ?? 1);
});

nodeProcess.on("exit", (code, signal) => {
  if (signal || exiting) return;
  cleanup(code ?? 1);
});
