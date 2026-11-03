import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...coreWebVitals,
  ...typescript,
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    // Legacy-file noise (unused imports, `any`, apostrophes in JSX text) was
    // never linted before; surfaced as warnings to be burned down, not blocking.
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "react/no-unescaped-entities": "warn",
      // eslint-plugin-react-hooks v7 (via eslint-config-next 16) added React
      // Compiler rules that flag 124 pre-existing sites. Warnings to burn down,
      // same policy as above -- not new regressions.
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/use-memo": "warn",
    },
  },
];
