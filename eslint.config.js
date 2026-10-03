import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "src/generated-version.ts"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
