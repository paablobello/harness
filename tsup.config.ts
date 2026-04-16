import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/main": "src/cli/main.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
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
