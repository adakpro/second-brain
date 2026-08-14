type DashboardSession = {
  cookie: string;
  loginPromise: Promise<string> | null;
};

const dashboardSession: DashboardSession = {
  cookie: "",
  loginPromise: null,
};

const allowedCookieNames = new Set([
  "hermes_session_at",
  "hermes_session_rt",
  "hermes_session_provider",
  "__Host-hermes_session_at",
  "__Host-hermes_session_rt",
  "__Host-hermes_session_provider",
  "__Secure-hermes_session_at",
  "__Secure-hermes_session_rt",
  "__Secure-hermes_session_provider",
]);

function dashboardBaseUrl() {
  return (process.env.HERMES_DASHBOARD_INTERNAL_URL ?? "http://hermes:9119").replace(/\/$/, "");
}

function updateCookies(headers: Headers) {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const raw = extended.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  const current = new Map(
    dashboardSession.cookie
      .split(/;\s*/)
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return [part.slice(0, separator), part.slice(separator + 1)] as const;
      }),
  );

  for (const header of raw) {
    const pattern = /(?:^|,\s*)((?:__Host-|__Secure-)?hermes_session_(?:at|rt|provider))=([^;,]*)/g;
    for (const match of header.matchAll(pattern)) {
      if (!allowedCookieNames.has(match[1])) continue;
      if (match[2]) current.set(match[1], match[2]);
      else current.delete(match[1]);
    }
  }
  dashboardSession.cookie = [...current].map(([name, value]) => `${name}=${value}`).join("; ");
  return dashboardSession.cookie;
}

async function login() {
  if (dashboardSession.loginPromise) return dashboardSession.loginPromise;
  dashboardSession.loginPromise = (async () => {
    const username = process.env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME;
    const password = process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD;
    if (!username || !password) throw new Error("Dashboard BFF credentials are not configured");
    const response = await fetch(`${dashboardBaseUrl()}/auth/password-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ provider: "basic", username, password, next: "/" }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Dashboard login failed (${response.status})`);
    const cookie = updateCookies(response.headers);
    if (!cookie) throw new Error("Dashboard login returned no session cookie");
    return cookie;
  })();
  try {
    return await dashboardSession.loginPromise;
  } finally {
    dashboardSession.loginPromise = null;
  }
}

export async function dashboardRequest(path: string, init: RequestInit = {}) {
  if (!path.startsWith("/api/")) throw new Error("Dashboard BFF only permits API paths");
  if (!dashboardSession.cookie) await login();

  const send = () => fetch(`${dashboardBaseUrl()}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
      Cookie: dashboardSession.cookie,
    },
    cache: "no-store",
  });

  let response = await send();
  updateCookies(response.headers);
  if (response.status === 401 || response.status === 403) {
    dashboardSession.cookie = "";
    await login();
    response = await send();
    updateCookies(response.headers);
  }
  return response;
}

export function sameOriginMutation(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function dashboardJsonResponse(path: string, init?: RequestInit) {
  try {
    const upstream = await dashboardRequest(path, init);
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { detail: error instanceof Error ? error.message : "Hermes dashboard is unavailable" },
      { status: 503 },
    );
  }
}
