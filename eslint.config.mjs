import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "**/*.tsbuildinfo"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // Async interface implementations and in-memory adapters may resolve synchronously.
      "@typescript-eslint/require-await": "off",
      // These are readability preferences rather than correctness checks; Prettier owns style.
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/prefer-optional-chain": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      // node:test returns promises from test registration; they must not be awaited at module scope.
      "@typescript-eslint/no-floating-promises": "off",
      // Test fixtures intentionally exercise dynamic script execution and untyped boundary data.
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-implied-eval": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off"
    }
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser }
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    }
  },
  eslintConfigPrettier
);
