import { spawn } from "node:child_process";
import type { HierarchyBuildInput, HierarchyBuildResult, PageIndexClient } from "../ports/hierarchy.js";

export const PAGEINDEX_OSS_ADAPTER_NAME = "pageindex-oss-markdown";
export const PAGEINDEX_OSS_SOURCE_PIN = "982514ab40fe42a169ea087c13819cf87c87724f";
export const PAGEINDEX_OSS_SOURCE_DIGEST = "b96135e27a2f725971a90ada1c8979d9110d640778bcbdae57b1587f97ffc0a5";

export interface LocalPageIndexProbe {
  readonly available: boolean;
  readonly reason?: string;
  readonly adapterName?: string;
  readonly adapterVersion?: string;
  readonly sourcePin?: string;
  readonly sourceDigest?: string;
}

export class LocalPageIndexClient implements PageIndexClient {
  constructor(
    private readonly options: {
      readonly python?: string;
      readonly workerPath?: string;
      readonly timeoutMs?: number;
    } = {}
  ) {}

  async probe(): Promise<LocalPageIndexProbe> {
    try {
      const value = JSON.parse(await this.run(["--probe"])) as Record<string, unknown>;
      if (value.available !== true) {
        return {
          available: false,
          reason: typeof value.reason === "string" ? value.reason.slice(0, 1_000) : "PageIndex worker is unavailable"
        };
      }
      return {
        available: true,
        ...(typeof value.adapterName === "string" ? { adapterName: value.adapterName } : {}),
        ...(typeof value.version === "string" ? { adapterVersion: value.version } : {}),
        ...(typeof value.sourcePin === "string" ? { sourcePin: value.sourcePin } : {}),
        ...(typeof value.sourceDigest === "string" ? { sourceDigest: value.sourceDigest } : {})
      };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async build(input: HierarchyBuildInput, signal: AbortSignal): Promise<HierarchyBuildResult> {
    const output = await this.run([], { operation: "build", input }, signal);
    const parsed = JSON.parse(output) as HierarchyBuildResult;
    if (
      !Array.isArray(parsed.nodes) ||
      typeof parsed.adapterName !== "string" ||
      typeof parsed.adapterVersion !== "string" ||
      !Array.isArray(parsed.diagnostics)
    ) {
      throw new Error("PageIndex worker returned an invalid hierarchy");
    }
    return parsed;
  }

  private run(args: string[], input?: unknown, signal?: AbortSignal): Promise<string> {
    const python = this.options.python ?? process.env.CONTEXT_PAGEINDEX_PYTHON?.trim() ?? "python3";
    const workerPath = this.options.workerPath ?? process.env.CONTEXT_PAGEINDEX_WORKER?.trim();
    if (!workerPath) return Promise.reject(new Error("CONTEXT_PAGEINDEX_WORKER is not configured"));
    return new Promise((resolve, reject) => {
      const child = spawn(python, [workerPath, ...args], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...(process.env.PAGEINDEX_SOURCE_ROOT ? { PAGEINDEX_SOURCE_ROOT: process.env.PAGEINDEX_SOURCE_ROOT } : {})
        },
        stdio: ["pipe", "pipe", "pipe"],
        signal
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => child.kill("SIGKILL"), this.options.timeoutMs ?? 15_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = `${stdout}${chunk}`.slice(-16 * 1024 * 1024);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-64 * 1024);
      });
      child.on("error", (error) => {
        settle(() => reject(error));
      });
      child.on("exit", (code, exitSignal) => {
        settle(() => {
          if (code === 0) {
            resolve(stdout.trim());
            return;
          }
          reject(
            new Error(
              exitSignal === "SIGKILL"
                ? "PageIndex worker timed out"
                : `PageIndex worker exited with ${code}: ${stderr.slice(-1_000)}`
            )
          );
        });
      });
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
}
