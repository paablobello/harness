import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/main": "src/cli/main.ts",
    "adapters/anthropic": "src/adapters/anthropic.ts",
    "adapters/openai": "src/adapters/openai.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  external: [
    "./adapters/anthropic.js",
    "./adapters/openai.js",
    "../adapters/anthropic.js",
    "../adapters/openai.js",
  ],
  target: "node20",
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: ({ format }) => {
    if (format === "esm") {
      return { js: "" };
    }
    return {};
  },
});
