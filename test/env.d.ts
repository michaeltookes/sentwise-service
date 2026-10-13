/// <reference types="@cloudflare/vitest-pool-workers/types" />
/// <reference types="vite/client" />
import type { Env as WorkerEnv } from "../src/config";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
