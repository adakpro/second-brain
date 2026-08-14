export type SolariRealtimeFunctionCall = {
  callId: string;
  name: string;
  argumentsText: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Realtime emits partial/done argument events even for interrupted Responses.
 * Tool work is released only from a terminal, successful `response.done`.
 */
export function completedSolariFunctionCalls(packet: unknown): SolariRealtimeFunctionCall[] {
  if (!isRecord(packet) || text(packet.type) !== "response.done" || !isRecord(packet.response)) return [];
  if (text(packet.response.status) !== "completed" || !Array.isArray(packet.response.output)) return [];

  return packet.response.output.flatMap((value) => {
    if (!isRecord(value) || text(value.type) !== "function_call" || text(value.status) !== "completed") return [];
    const name = text(value.name);
    const callId = text(value.call_id);
    const argumentsText = typeof value.arguments === "string" ? value.arguments : "";
    if (!name || !callId || callId.length > 200 || argumentsText.length > 4_096) return [];
    return [{ callId, name, argumentsText }];
  }).slice(0, 8);
}
