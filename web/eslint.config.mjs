// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", ".astro/", "node_modules/", "playwright-report/", "test-results/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "e2e/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The component deliberately uses a mutable ref (G) + force-rerender so
      // keyboard handlers and async continuations read live state; dependency
      // arrays cannot express that pattern.
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-render": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);
