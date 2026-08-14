import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;
let credentialMutationQueue: Promise<void> = Promise.resolve();

export type SafeCredentialEntry = {
  index: number;
  id?: string;
  label?: string;
  auth_type?: string;
  source?: string;
  priority?: number;
  last_status?: string;
  request_count?: number;
  token_preview?: string;
  has_refresh?: boolean;
  revision: string;
};

export type SafeCredentialProvider = { provider: string; entries: SafeCredentialEntry[] };

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function credentialRevision(provider: string, entry: Omit<SafeCredentialEntry, "revision">) {
  const identity = [provider, entry.index, entry.id, entry.label, entry.auth_type, entry.source, entry.token_preview, entry.has_refresh];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function sanitizeCredentialPool(value: unknown): SafeCredentialProvider[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const rawProviders = (value as JsonRecord).providers;
  if (!Array.isArray(rawProviders)) return [];
  return rawProviders.flatMap((rawProvider) => {
    if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) return [];
    const providerRow = rawProvider as JsonRecord;
    const provider = optionalString(providerRow.provider);
    if (!provider || !Array.isArray(providerRow.entries)) return [];
    const entries = providerRow.entries.flatMap((rawEntry) => {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return [];
      const row = rawEntry as JsonRecord;
      const index = optionalNumber(row.index);
      if (!index || !Number.isInteger(index)) return [];
      const entry: Omit<SafeCredentialEntry, "revision"> = {
        index,
        id: optionalString(row.id),
        label: optionalString(row.label),
        auth_type: optionalString(row.auth_type),
        source: optionalString(row.source),
        priority: optionalNumber(row.priority),
        last_status: optionalString(row.last_status),
        request_count: optionalNumber(row.request_count),
        token_preview: optionalString(row.token_preview),
        has_refresh: typeof row.has_refresh === "boolean" ? row.has_refresh : undefined,
      };
      return [{ ...entry, revision: credentialRevision(provider, entry) }];
    });
    return [{ provider, entries }];
  });
}

export function serializeCredentialMutation<T>(operation: () => Promise<T>) {
  const result = credentialMutationQueue.then(operation, operation);
  credentialMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}
