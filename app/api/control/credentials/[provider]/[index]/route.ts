export const dynamic = "force-dynamic";

export async function DELETE() {
  return Response.json({ detail: "Credential removal is unavailable in HERMESS because upstream entries use positional indexes" }, { status: 410 });
}
