import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Allow `any` type as warning - core types are implemented, peripheral areas still need typing
      "@typescript-eslint/no-explicit-any": "warn",
      // Shared Clio viewer code: only its framework-free modules. The
      // import-graph test (src/lib/clio/__tests__) also checks what they import.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^@clio-viewer/(capture(/index)?|capture/object-tracks-view|scene|panel|main|episode-data)(\\.ts)?$",
              message:
                "Import only the framework-free viewer modules: capture/model, capture/from-clio, capture/clio-events, capture/from-package, api, event-log, detection-outline.",
            },
            {
              regex: "(^|/)apps/headset/",
              message: "Import shared viewer code through @clio-viewer/*.",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
