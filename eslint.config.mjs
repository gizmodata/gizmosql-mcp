import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

export default tseslint.config(
  {
    ignores: ["dist/**", "build/**", "node_modules/**", "drivers/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "prefer-const": ["error", { destructuring: "all" }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: { globals: nodeGlobals },
  },
);
