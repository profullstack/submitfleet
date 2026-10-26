import { getPasskey, passkeysSupported } from './webauthn.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const next = (() => {
  const n = params.get('next');
  // Same-site paths only: never //host or /\host (browsers read a backslash as a slash).
  return n && /^\/(?![\/\\])[^\s\\]*$/.test(n) ? n : '/app';
})();

function say(text, kind = 'info') {
  const m = $('#msg');
  m.className = `notice ${kind}`;
  m.textContent = text;
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Something went wrong (HTTP ${res.status})`);
  return data;
}

async function signInWithPasskey(mediation) {
  const { challenge_id, options } = await post('/api/auth/passkey/login/options');
  const response = await getPasskey(options, mediation);
  await post('/api/auth/passkey/login/verify', { challenge_id, response });
  location.assign(next);
}

// ── /auth/link: spend the emailed token only when the person presses Continue ──
if (location.pathname === '/auth/link') {
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || params.get('t');
  history.replaceState(null, '', '/auth/link');
  const btn = $('#continue');
  if (!token) {
    say('This link is incomplete. Request a new one from the sign-in page.', 'bad');
    btn.disabled = true;
  }
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await post('/api/auth/link', { token });
      location.assign(r.created ? '/app?welcome=1' : next);
    } catch (e) {
      say(e.message, 'bad');
      btn.disabled = false;
    }
  });
} else {
  const signup = location.pathname === '/signup';
  let mode = 'password';
  if (signup) {
    $('#title').textContent = 'Create your account';
    $('#subtitle').textContent = 'Free to start. We email you once to confirm the address.';
    $('#password').autocomplete = 'new-password';
    $('#password-hint').hidden = false;
    $('#submit').textContent = 'Create account';
    $('#passkey').hidden = true;
    document.querySelector('.divider').hidden = true;
    $('#tab-password').textContent = 'With a password';
    $('#tab-link').textContent = 'Email link only';
    $('#switch').innerHTML = 'Already have an account? <a href="/login">Sign in</a>';
  } else {
    $('#switch').innerHTML = 'New here? <a href="/signup">Create an account</a>';
  }
  if (params.get('next')) for (const a of document.querySelectorAll('#switch a')) a.href += `?next=${encodeURIComponent(next)}`;

  const setMode = (m) => {
    mode = m;
    $('#tab-password').setAttribute('aria-selected', String(m === 'password'));
    $('#tab-link').setAttribute('aria-selected', String(m === 'link'));
    $('#password-field').hidden = m !== 'password';
    $('#submit').textContent = m === 'link' ? (signup ? 'Email me a sign-up link' : 'Email me a sign-in link') : signup ? 'Create account' : 'Sign in';
  };
  $('#tab-password').addEventListener('click', () => setMode('password'));
  $('#tab-link').addEventListener('click', () => setMode('link'));

  if (!passkeysSupported()) {
    $('#passkey').hidden = true;
    document.querySelector('.divider').hidden = true;
  }
  $('#passkey').addEventListener('click', async () => {
    try {
      await signInWithPasskey();
    } catch (e) {
      if (e.name !== 'NotAllowedError') say(e.message, 'bad');
    }
  });

  $('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('#email').value.trim();
    const password = $('#password').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say('Enter a valid email address.', 'bad');
    // Sign-up profile fields (rendered on /signup only); first and last name are required.
    const profile = {};
    for (const k of ['first_name', 'last_name', 'company_domain', 'job_title', 'linkedin_url']) {
      const el = document.querySelector(`#form [name="${k}"]`);
      if (el) profile[k] = el.value.trim();
    }
    if (signup && (!profile.first_name || !profile.last_name)) return say('Enter your first and last name.', 'bad');
    const btn = $('#submit');
    btn.disabled = true;
    try {
      if (mode === 'link') {
        const r = await post(signup ? '/api/auth/signup' : '/api/auth/magic', signup ? { email, ...profile } : { email });
        say(r.message, 'ok');
      } else if (signup) {
        if (password.length < 10) throw new Error('Use a password of at least 10 characters, or choose "Email link only".');
        const r = await post('/api/auth/signup', { email, password, ...profile });
        say(`${r.message} Open it to confirm your account.`, 'ok');
      } else {
        await post('/api/auth/login', { email, password });
        location.assign(next);
        return;
      }
    } catch (e) {
      say(e.message, 'bad');
    }
    btn.disabled = false;
  });
}
