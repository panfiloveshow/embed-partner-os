import { defineConfig } from "vitest/config";

// Юнит-тесты lib/ (*.test.ts) остаются в node-окружении: api.test.ts опирается на
// нативные Node-глобалы (Response, FormData, fetch). Компонентные тесты (*.test.tsx)
// выполняются в jsdom с матчерами @testing-library/jest-dom.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "components",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["src/test/setup.ts"],
        },
      },
    ],
  },
});
