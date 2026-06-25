import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    ignores: ["dist/**"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: "module",
        projectService: {
          allowDefaultProject: ["*.config.*"],
        },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // TODO: tighten to "error" once existing unused vars are cleaned up
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-var-requires": "off",
    },
  },
];
