// Isolate every fixture run from the operator's local catalogs and archive.
import { fileURLToPath } from "node:url";
process.env.WORKFLOW_CONFIG_DIR = fileURLToPath(new URL("../test/config/", import.meta.url));
// Launch records come from the archive, so tests read invented ones.
process.env.WORKFLOW_ARCHIVE = fileURLToPath(new URL("../test/archive/", import.meta.url));
