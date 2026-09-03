import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Works for both layouts: `dist/version.js` (npm package) and
// `server/version.js` (MCPB bundle) — package.json sits one level up.
const pkg = require("../package.json") as { name: string; version: string };

export const PACKAGE_NAME: string = pkg.name;
export const PACKAGE_VERSION: string = pkg.version;
