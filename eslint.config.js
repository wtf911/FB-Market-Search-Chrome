import globals from "globals";

// The extension files run as classic scripts in three different globals (service
// worker, content-script isolated world, extension pages); `MDS` comes from shared.js.
export default [
  { ignores: ["node_modules/**", "*.zip", "test-results/**"] },
  {
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions, MDS: "readonly", importScripts: "readonly", navigation: "readonly" },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "prefer-const": "warn",
      "no-var": "error",
    },
  },
  {
    files: ["eslint.config.js", "tests/**/*.mjs"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { ...globals.node } },
  },
];
