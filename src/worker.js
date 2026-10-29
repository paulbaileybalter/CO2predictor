/* Password gate + shared storage for the Balter CO2 Predictor.
   - Password only (no username): /login form sets a signed cookie valid for 30 days.
   - /api/state (GET/PUT) keeps the readings, board and settings in Workers KV so everyone sees the same data.
   Secrets/bindings: SITE_PASSWORD (secret), DATA (KV namespace), ASSETS (static files from ./public). */

const enc = new TextEncoder();
const COOKIE = 'balter_co2';
const MAX_AGE = 60 * 60 * 24 * 30;

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function safeEqual(a, b) {
  const [x, y] = (await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])).map((h) => new Uint8Array(h));
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const token = (env) => hmac(env.SITE_PASSWORD, 'balter-co2-session-v1');
async function authed(request, env) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(COOKIE + '=([a-f0-9]+)'));
  return !!m && (await safeEqual(m[1], await token(env)));
}

const page = (msg) => `<!DOCTYPE html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Sign in — Balter CO2 Predictor</title><link rel="icon" href="/favicon.svg">
<style>@font-face{font-family:Lexend;src:url(/fonts/lexend-latin-wght-normal.woff2) format('woff2');font-weight:100 900}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;font-family:Lexend,system-ui,sans-serif;border-top:5px solid #47D7AC}
form{width:min(360px,88vw);border:1px solid #E7E5DE;border-radius:14px;padding:28px 24px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 6px 16px rgba(0,0,0,.05)}
img{width:48px;height:48px}small{display:block;margin-top:10px;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#7566A0;font-weight:600}
h1{font-size:21px;margin:4px 0 18px}input{width:100%;box-sizing:border-box;border:1px solid #E7E5DE;border-radius:10px;padding:11px 12px;font:inherit}
input:focus{outline:none;border-color:#47D7AC;box-shadow:0 0 0 3px rgba(71,215,172,.25)}
button{margin-top:12px;width:100%;border:1px solid #47D7AC;background:#47D7AC;border-radius:10px;padding:11px;font:inherit;font-weight:600;cursor:pointer}
button:hover{background:#000;color:#fff;border-color:#000}p{color:#b3261e;font-size:13px;margin:10px 0 0}</style></head>
<body><form method="post" action="/login"><img src="/logo.svg" alt="Balter Brewing"><small>Balter Brewing · Supply Planning</small><h1>CO2 Usage Predictor</h1>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required><button>Sign in</button>${msg ? `<p>${msg}</p>` : ''}</form></body></html>`;
const html = (body, status) => new Response(body, { status: status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });

export default {
  async fetch(request, env) {
    if (!env.SITE_PASSWORD) return new Response('SITE_PASSWORD secret is not set on this Worker.', { status: 500 });
    const url = new URL(request.url);

    if (url.pathname === '/login') {
      if (request.method === 'POST') {
        const pw = String((await request.formData()).get('password') || '');
        if (await safeEqual(pw, env.SITE_PASSWORD)) {
          return new Response(null, { status: 303, headers: { Location: '/', 'Cache-Control': 'no-store',
            'Set-Cookie': `${COOKIE}=${await token(env)}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Strict` } });
        }
        return html(page('That password is not right.'), 401);
      }
      // the login page needs its own logo/font before sign-in
      return html(page(''));
    }
    if (url.pathname === '/logout') {
      return new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict` } });
    }
    // assets the login page itself uses
    if (['/logo.svg', '/favicon.svg', '/fonts/lexend-latin-wght-normal.woff2'].includes(url.pathname)) return env.ASSETS.fetch(request);

    if (!(await authed(request, env))) {
      if (url.pathname.startsWith('/api/')) return new Response('Unauthorised', { status: 401 });
      return new Response(null, { status: 303, headers: { Location: '/login', 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/api/state') {
      if (!env.DATA) return new Response('KV namespace DATA is not bound.', { status: 501 });
      if (request.method === 'GET') {
        const v = await env.DATA.get('state');
        return new Response(v || 'null', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (request.method === 'PUT') {
        const body = await request.text();
        if (body.length > 5e6) return new Response('Too large', { status: 413 });
        try { JSON.parse(body); } catch (e) { return new Response('Bad JSON', { status: 400 }); }
        await env.DATA.put('state', body);
        return new Response('ok');
      }
      return new Response('Method not allowed', { status: 405 });
    }

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    out.headers.set('Cache-Control', 'private, no-cache');
    out.headers.set('X-Content-Type-Options', 'nosniff');
    return out;
  }
};
