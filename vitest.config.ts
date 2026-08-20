import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only dummy bindings. Clerk and Anthropic are mocked in tests,
        // so these values never reach a real service.
        bindings: {
          CLERK_SECRET_KEY: "sk_test_dummy",
          ANTHROPIC_API_KEY: "sk-ant-dummy",
          CLERK_PUBLISHABLE_KEY: "pk_test_dummy",
        },
      },
    }),
  ],
});
