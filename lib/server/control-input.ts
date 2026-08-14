export const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/;

export function profileFromRequest(request: Request) {
  const value = new URL(request.url).searchParams.get("profile")?.trim() || "default";
  return identifierPattern.test(value) ? value : null;
}

export async function readObjectBody(request: Request) {
  const value = await request.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength && !/[\r\n]/.test(text) ? text : null;
}
