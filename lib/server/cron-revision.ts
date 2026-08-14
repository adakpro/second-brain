import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;
let cronMutationQueue: Promise<void> = Promise.resolve();

const authorFields = [
  "id", "name", "schedule", "prompt", "deliver", "skills", "model", "provider",
  "base_url", "script", "context_from", "enabled_toolsets", "workdir", "no_agent",
  "attach_to_session", "origin", "enabled",
] as const;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  const record = value as JsonRecord;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
}

export function cronRevision(profile: string, value: JsonRecord) {
  const repeat = value.repeat && typeof value.repeat === "object" && !Array.isArray(value.repeat)
    ? value.repeat as JsonRecord
    : {};
  const identity = {
    ...Object.fromEntries(authorFields.map((field) => [field, stable(value[field])])),
    repeat_times: stable(repeat.times),
  };
  return createHash("sha256").update(profile).update("\0").update(JSON.stringify(identity)).digest("hex");
}

export function withCronRevision(profile: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const job = value as JsonRecord;
  return { ...job, _revision: cronRevision(profile, job) };
}

export function serializeCronMutation<T>(operation: () => Promise<T>) {
  const result = cronMutationQueue.then(operation, operation);
  cronMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}
