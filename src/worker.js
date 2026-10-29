/* Password gate for the Balter CO2 Predictor.
   Every request must carry HTTP Basic credentials whose password matches the SITE_PASSWORD secret
   (the username is ignored). Static files are served from ./public through the ASSETS binding. */

const enc = new TextEncoder();

async function safeEqual(a, b) {
  // hash both sides so the comparison is constant-length and constant-time
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function challenge() {
  return new Response('Password required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Balter CO2 Predictor", charset="UTF-8"', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }
  });
}

export default {
  async fetch(request, env) {
    if (!env.SITE_PASSWORD) return new Response('SITE_PASSWORD secret is not set on this Worker.', { status: 500 });
    const header = request.headers.get('Authorization') || '';
    if (!header.startsWith('Basic ')) return challenge();
    let pass = '';
    try {
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
      pass = decoded.slice(decoded.indexOf(':') + 1);
    } catch (e) { return challenge(); }
    if (!(await safeEqual(pass, env.SITE_PASSWORD))) return challenge();

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    out.headers.set('Cache-Control', 'private, no-cache');
    out.headers.set('X-Content-Type-Options', 'nosniff');
    return out;
  }
};
