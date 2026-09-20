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
          PADDLE_WEBHOOK_SECRET: "pdl_ntfset_testsecret",
          PADDLE_CHECKOUT_BINDING_PREVIOUS_SECRET: "old_checkout_binding_secret",
          PADDLE_API_KEY: "pdl_apikey",
          PADDLE_API_BASE: "https://sandbox-api.paddle.com",
          // Deployed wrangler.jsonc now carries the LIVE tier price ids (item
          // 74); blank them here so tests exercise the sandbox fallback map.
          PADDLE_STARTER_PRICE_ID: "",
          PADDLE_PRO_PRICE_ID: "",
          PADDLE_UNLIMITED_PRICE_ID: "",
        },
      },
    }),
  ],
});
