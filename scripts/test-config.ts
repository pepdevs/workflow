// Isolate every fixture run from the operator's local catalogs.
import { fileURLToPath } from "node:url";
process.env.WORKFLOW_CONFIG_DIR = fileURLToPath(new URL("../test/config/", import.meta.url));
