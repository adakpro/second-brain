import { createHmac } from "node:crypto";

let profileMutationQueue: Promise<void> = Promise.resolve();

export function profileConfigRevision(profile: string, rawYaml: string) {
  // Raw config contains the complete model assignment, including provider
  // endpoint state omitted by Hermes' normalized web config. Key the digest so
  // the browser never receives a reusable hash oracle for secret-bearing YAML.
  const key = process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD;
  if (!key) throw new Error("Profile revision key is unavailable");
  return createHmac("sha256", key)
    .update(profile)
    .update("\0")
    .update(rawYaml)
    .digest("hex");
}

export function serializeProfileMutation<T>(operation: () => Promise<T>) {
  const result = profileMutationQueue.then(operation, operation);
  profileMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}
