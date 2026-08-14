import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;
let mcpMutationQueue: Promise<void> = Promise.resolve();

const identityFields = ["name", "transport", "url", "command", "args", "env", "auth", "enabled", "tools"] as const;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  const record = value as JsonRecord;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
}

export function mcpRevision(profile: string, server: JsonRecord) {
  const identity = Object.fromEntries(identityFields.map((field) => [field, stable(server[field])]));
  return createHash("sha256").update(profile).update("\0").update(JSON.stringify(identity)).digest("hex");
}

export function serversWithRevisions(profile: string, value: unknown): Array<JsonRecord & { revision: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const servers = (value as JsonRecord).servers;
  if (!Array.isArray(servers)) return [];
  return servers.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const server = value as JsonRecord;
    return [{ ...server, revision: mcpRevision(profile, server) }];
  });
}

export function serializeMcpMutation<T>(operation: () => Promise<T>) {
  const result = mcpMutationQueue.then(operation, operation);
  mcpMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}
