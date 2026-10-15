// Pi prints the credential it holds for a provider, refreshing an OAuth token first.
import { capture } from "../common/processes.ts";

const TIMEOUT_MS = 10_000;

export const piBearerToken = (provider: string) => capture("pi", ["auth", "print-bearer-token", "--provider", provider, "--min-expiry", "1m"], TIMEOUT_MS);
export const piApiKey = (provider: string) => capture("pi", ["auth", "print-api-key", "--provider", provider], TIMEOUT_MS);
