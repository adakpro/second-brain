export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ status: "ok", service: "hermess-frontend", time: new Date().toISOString() });
}
