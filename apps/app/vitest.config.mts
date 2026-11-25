import { defineConfig } from "vitest/config";

// Only the parts of the app that are plain TypeScript are tested here: the
// words for each state and the API client. Nothing that imports React Native.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
