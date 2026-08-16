const PASSWORD = '123';
const COOKIE_NAME = 'bentopdf_access';
const COOKIE_VALUE = 'granted';

function loginPage(error = false): Response {
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
    <form method="post">
      <input name="password" type="password" autocomplete="current-password" placeholder="Password" autofocus required />
      <button type="submit">Enter</button>
    </form>
    ${error ? '<div class="error">Wrong password.</div>' : ''}
  </main>
</body>
</html>`;

  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

export default async function middleware(request: Request) {
  const cookie = request.headers.get('cookie') || '';
  const hasAccess = cookie
    .split(';')
    .map((part) => part.trim())
    .includes(`${COOKIE_NAME}=${COOKIE_VALUE}`);

  if (hasAccess) return;

  if (request.method === 'POST') {
    const form = await request.formData();
    const password = String(form.get('password') || '');

    if (password === PASSWORD) {
      return new Response(null, {
        status: 303,
        headers: {
          location: new URL(request.url).pathname || '/',
          'set-cookie': `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
          'cache-control': 'no-store, max-age=0',
        },
      });
    }

    return loginPage(true);
  }

  return loginPage(false);
}
