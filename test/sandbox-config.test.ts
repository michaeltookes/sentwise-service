// Sandbox deployment config guard (sentwise item 123, docs/sandbox-deployment.md).
//
// The sandbox is the production code deployed a second time with different
// values. These tests keep the two deployments in lockstep: the `sandbox`
// wrangler environment must restate every binding and var production has (Wrangler
// does not inherit them), and no source file may know the sandbox exists.

import { describe, it, expect } from "vitest";
import wranglerSource from "../wrangler.jsonc?raw";

const sourceFiles = import.meta.glob<string>("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Strip // and /* *\/ comments and trailing commas from JSONC, respecting strings. */
function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      i = text.indexOf("*/", i + 2) + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface Deployment {
  name?: string;
  vars?: Record<string, string>;
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  analytics_engine_datasets?: { binding: string; dataset: string }[];
  kv_namespaces?: { binding: string; id: string }[];
  workers_dev?: boolean;
  routes?: unknown[];
}
type Config = Deployment & { env?: Record<string, Deployment> };

const config = parseJsonc(wranglerSource) as Config;
const sandbox = config.env?.sandbox;

function bindingNames(d: Deployment): Record<string, string[]> {
  return {
    durable_objects: (d.durable_objects?.bindings ?? []).map((b) => `${b.name}:${b.class_name}`),
    analytics_engine_datasets: (d.analytics_engine_datasets ?? []).map((b) => b.binding),
    kv_namespaces: (d.kv_namespaces ?? []).map((b) => b.binding),
  };
}

describe("sandbox wrangler environment", () => {
  it("exists as its own Worker with its own hostname", () => {
    expect(sandbox).toBeDefined();
    expect(sandbox!.name).toBe("sentwise-inference-sandbox");
    expect(sandbox!.name).not.toBe(config.name);
    expect(sandbox!.workers_dev === true || (sandbox!.routes ?? []).length > 0).toBe(true);
  });

  it("restates every production binding (names only)", () => {
    const prod = bindingNames(config);
    const sb = bindingNames(sandbox!);
    for (const kind of Object.keys(prod)) {
      expect(sb[kind], kind).toEqual(expect.arrayContaining(prod[kind]));
    }
  });

  it("writes analytics to its own dataset and points the dashboard at it", () => {
    const prodDatasets = (config.analytics_engine_datasets ?? []).map((d) => d.dataset);
    const sbDatasets = (sandbox!.analytics_engine_datasets ?? []).map((d) => d.dataset);
    for (const ds of sbDatasets) expect(prodDatasets).not.toContain(ds);
    expect(sbDatasets).toContain(sandbox!.vars?.USAGE_DATASET_NAME);
    expect(prodDatasets).toContain(config.vars?.USAGE_DATASET_NAME);
  });

  it("sets every var production sets (names only)", () => {
    const prodVars = Object.keys(config.vars ?? {});
    expect(prodVars.length).toBeGreaterThan(0);
    expect(Object.keys(sandbox!.vars ?? {})).toEqual(expect.arrayContaining(prodVars));
  });

  it("uses the Paddle sandbox API and never production price ids", () => {
    const v = sandbox!.vars!;
    expect(v.PADDLE_API_BASE).toBe("https://sandbox-api.paddle.com");
    for (const key of [
      "PADDLE_STARTER_PRICE_ID",
      "PADDLE_PRO_PRICE_ID",
      "PADDLE_UNLIMITED_PRICE_ID",
    ]) {
      expect(v[key], key).not.toBe(config.vars?.[key]);
    }
    expect(v.CLERK_PUBLISHABLE_KEY).not.toBe(config.vars?.CLERK_PUBLISHABLE_KEY);
    expect(v.CLERK_PUBLISHABLE_KEY?.startsWith("pk_live_")).toBe(false);
  });

  it("leaves production on the live Paddle API", () => {
    expect(config.vars?.PADDLE_API_BASE).toBe("https://api.paddle.com");
  });

  it("forwards OAuth callbacks to the QA build's own URL scheme", () => {
    expect(config.vars?.APP_CALLBACK_SCHEME).toBe("sentwise");
    expect(sandbox!.vars?.APP_CALLBACK_SCHEME).toBe("sentwise-qa");
  });
});

describe("source has no sandbox awareness", () => {
  it("found the source files", () => {
    expect(Object.keys(sourceFiles).length).toBeGreaterThan(10);
  });

  it("no file under src/ mentions the sandbox", () => {
    const offenders = Object.entries(sourceFiles)
      .filter(([, text]) => /sandbox/i.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
