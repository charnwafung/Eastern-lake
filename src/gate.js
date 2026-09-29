// Private mode: while it's on, every customer page asks for a password, so nobody can order while the
// site is being adjusted. Managers turn it on/off and set the password from the kitchen screen (Tienda).
// The kitchen screen, the Stripe webhook and the health check keep working.
const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');

const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const state = () => getSetting('gate', { on: false, salt: null, hash: null, v: 1 });

function info() { const g = state(); return { on: !!g.on, hasPassword: !!g.hash }; }
function setPassword(pw) {
  const g = state(); const salt = crypto.randomBytes(16).toString('hex');
  setSetting('gate', { ...g, salt, hash: hash(pw, salt), v: (g.v || 1) + 1 }); // new password signs out old visitors
}
function setOn(on) { setSetting('gate', { ...state(), on: !!on }); }
function check(pw) { const g = state(); return !!(g.hash && pw && same(hash(pw, g.salt), g.hash)); }

// Cookie token: version.expiry.signature
function token(secret) {
  const g = state(); const exp = Date.now() + 1000 * 60 * 60 * 24 * 30;
  const sig = crypto.createHmac('sha256', secret).update(`gate.${g.v}.${exp}`).digest('hex');
  return `${g.v}.${exp}.${sig}`;
}
function valid(t, secret) {
  const [v, exp, sig] = String(t || '').split('.');
  if (!sig || Number(exp) < Date.now() || Number(v) !== (state().v || 1)) return false;
  return same(sig, crypto.createHmac('sha256', secret).update(`gate.${v}.${exp}`).digest('hex'));
}

// Paths that stay open while the site is private.
const OPEN = [/^\/kitchen(\/|$)/, /^\/cocina$/, /^\/api\/kitchen\//, /^\/api\/gate$/, /^\/assets\//, /^\/healthz$/, /^\/webhook\//, /^\/favicon/, /^\/robots\.txt$/];
const isOpen = (p) => OPEN.some((re) => re.test(p));

const page = () => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Eastern Lake · Volvemos pronto</title><meta name="theme-color" content="#0e3b33">
<link rel="icon" href="/assets/favicon-32.png" type="image/png">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:#0e3b33;color:#17211d;font:16px/1.5 "DM Sans",system-ui,sans-serif}
.card{width:100%;max-width:380px;background:#fffdf8;border-radius:22px;padding:30px 24px 26px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.25)}
img{width:64px;height:64px;border-radius:50%;box-shadow:0 0 0 2px #b08d57}
h1{font:700 28px/1.15 Fraunces,Georgia,serif;color:#0e3b33;margin:14px 0 6px}
p{margin:0 0 20px;color:#4a544e}
input{width:100%;font:inherit;font-size:17px;padding:14px 16px;border:1.5px solid #d9cfbb;border-radius:14px;background:#fff;text-align:center;outline:none}
input:focus{border-color:#0e3b33;box-shadow:0 0 0 3px rgba(14,59,51,.15)}
button{margin-top:12px;width:100%;font:700 15px "DM Sans",sans-serif;letter-spacing:.08em;text-transform:uppercase;padding:15px;border:0;border-radius:99px;background:#0e3b33;color:#fffdf8;cursor:pointer}
button:disabled{opacity:.6}
.err{min-height:22px;margin-top:10px;color:#a4321e;font-size:14px}
.call{margin-top:18px;font-size:14px;color:#4a544e}.call a{color:#0e3b33;font-weight:700;text-decoration:none;white-space:nowrap}
</style></head><body>
<form class="card" id="f">
  <img src="/assets/logo-icon.png" alt="">
  <h1>Volvemos pronto</h1>
  <p>Estamos haciendo unos ajustes a nuestra página. Mientras tanto, llámanos para ordenar o pasa por el servicarro.</p>
  <input id="pw" type="password" autocomplete="current-password" placeholder="Contraseña" aria-label="Contraseña">
  <button id="b" type="submit">Entrar</button>
  <div class="err" id="e" role="alert"></div>
  <div class="call"><a href="tel:+17872920920">787-292-0920</a> · <a href="tel:+17872927759">787-292-7759</a></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault(); const b = document.getElementById('b'), e = document.getElementById('e');
  b.disabled = true; e.textContent = '';
  try {
    const r = await fetch('/api/gate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Contraseña incorrecta');
    location.reload();
  } catch (err) { e.textContent = err.message; b.disabled = false; document.getElementById('pw').select(); }
});
</script></body></html>`;

module.exports = { info, setPassword, setOn, check, token, valid, isOpen, page };
