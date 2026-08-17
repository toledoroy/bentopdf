const DEFAULT_PASSWORD = '123';
const COOKIE_NAME = '__Host-bentopdf_access';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_LOGIN_BODY_BYTES = 4096;
const encoder = new TextEncoder();

function sitePassword(): string {
  return process.env.SITE_PASSWORD?.trim() || DEFAULT_PASSWORD;
}

function authSecret(): string {
  const configuredSecret = process.env.AUTH_SECRET?.trim() || sitePassword();
  // Bind sessions to both the private signing secret and the current password,
  // so changing either value invalidates every existing cookie.
  return `${configuredSecret}\u0000${sitePassword()}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(value)
  );
  return bytesToHex(new Uint8Array(digest));
}

async function hmac(value: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(authSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(value)
  );
  return bytesToHex(new Uint8Array(signature));
}

async function securePasswordMatch(candidate: string): Promise<boolean> {
  const [candidateHash, expectedHash] = await Promise.all([
    sha256(candidate),
    sha256(sitePassword()),
  ]);
  return constantTimeEqual(candidateHash, expectedHash);
}

async function createSessionToken(): Promise<string> {
  const expiresAt =
    Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${expiresAt}`;
  return `${payload}.${await hmac(payload)}`;
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;

    const cookieName = part.slice(0, separator).trim();
    if (cookieName !== name) continue;

    return part.slice(separator + 1).trim();
  }

  return null;
}

async function hasValidSession(request: Request): Promise<boolean> {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;

  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now) return false;
  if (expiresAt > now + SESSION_TTL_SECONDS + 300) return false;

  const payload = `v1.${expiresAt}`;
  const expected = await hmac(payload);
  return constantTimeEqual(parts[2], expected);
}

function securityHeaders(): Headers {
  const headers = new Headers({
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    expires: '0',
    'x-robots-tag': 'noindex, nofollow',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  return headers;
}

function loginPage(error = false, status?: number): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Private PDF Tools</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111827; color: #f9fafb; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(92vw, 360px); background: #1f2937; border: 1px solid #374151; border-radius: 14px; padding: 28px; box-shadow: 0 18px 50px rgba(0,0,0,.35); }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0 0 20px; color: #9ca3af; font-size: 14px; }
    input { width: 100%; padding: 12px 14px; border-radius: 9px; border: 1px solid #4b5563; background: #111827; color: white; font-size: 16px; outline: none; }
    input:focus { border-color: #6366f1; }
    button { width: 100%; margin-top: 12px; padding: 12px 14px; border: 0; border-radius: 9px; background: #4f46e5; color: white; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #4338ca; }
    .error { margin: 12px 0 0; color: #fca5a5; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <h1>PDF Tools</h1>
    <p>This site is private.</p>
    <form method="post" action="">
      <input name="password" type="password" autocomplete="current-password" maxlength="256" placeholder="Password" autofocus required />
      <button type="submit">Enter</button>
    </form>
    ${error ? '<div class="error">Wrong password or invalid request.</div>' : ''}
  </main>
</body>
</html>`;

  const headers = securityHeaders();
  headers.set('content-type', 'text/html; charset=utf-8');

  return new Response(html, {
    status: status ?? (error ? 401 : 200),
    headers,
  });
}

function methodNotAllowed(): Response {
  const headers = securityHeaders();
  headers.set('allow', 'GET, HEAD, POST');
  return new Response(null, { status: 405, headers });
}

function requestIsSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

async function readLoginPassword(request: Request): Promise<string | null> {
  const contentType = (
    request.headers.get('content-type') ?? ''
  )
    .split(';', 1)[0]
    .trim()
    .toLowerCase();

  if (contentType !== 'application/x-www-form-urlencoded') {
    return null;
  }

  const declaredLength = Number(
    request.headers.get('content-length') ?? '0'
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_LOGIN_BODY_BYTES
  ) {
    return null;
  }

  const body = await request.text();
  if (body.length > MAX_LOGIN_BODY_BYTES) return null;

  const password = new URLSearchParams(body).get('password');
  if (password === null || password.length > 256) return null;
  return password;
}

export default async function middleware(request: Request) {
  if (!globalThis.crypto?.subtle) {
    return new Response('Authentication unavailable.', {
      status: 503,
      headers: securityHeaders(),
    });
  }

  if (await hasValidSession(request)) return;

  if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
    return methodNotAllowed();
  }

  if (request.method === 'POST') {
    if (!requestIsSameOrigin(request)) {
      return loginPage(true, 403);
    }

    const password = await readLoginPassword(request);
    if (
      password !== null &&
      (await securePasswordMatch(password))
    ) {
      const url = new URL(request.url);
      const token = await createSessionToken();
      const headers = securityHeaders();

      headers.set('location', `${url.pathname}${url.search}`);
      headers.set(
        'set-cookie',
        `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`
      );

      return new Response(null, { status: 303, headers });
    }

    return loginPage(true);
  }

  return loginPage(false);
}
