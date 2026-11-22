// Cosmo Rocket on Cloudflare Workers + Durable Object (free plan). Virtual coins only.
const DAY = 24 * 3600 * 1000;
const GROWTH = 0.09, BET_MS = 7000, CRASHED_MS = 4000;
const LEVELS = [0, 50, 150, 400, 900, 1800, 3500, 7000, 14000, 30000];
const ARENA_TIERS = [10, 50, 200], FEE = 0.05, ARENA_WAIT = 25000;
const WHEEL = [{ v: 1, w: 10 }, { v: 2, w: 40 }, { v: 4, w: 40 }, { v: 8, w: 6 }, { v: 10, w: 4 }]; // 2 & 4 = 80%
const levelOf = xp => { let l = 0; LEVELS.forEach((t, i) => { if (xp >= t) l = i + 1; }); return l; };
const r2 = n => Math.round(n * 100) / 100;
const JSONH = { 'content-type': 'application/json' };
const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: JSONH });

async function validateInitData(init, token) {
  if (!token || !init) return null;
  const p = new URLSearchParams(init);
  const hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(token));
  const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k2, enc.encode(str));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/tg/') || url.pathname.startsWith('/setup/')) {
      return env.GAME.get(env.GAME.idFromName('main')).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

export class Game {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.ready = state.blockConcurrencyWhile(() => this.load());
  }
  async load() {
    const s = this.state.storage;
    this.meta = (await s.get('meta')) || { settings: { minMult: 1.0, maxMult: 50, edge: 0.04, queue: [], startCoins: 20 }, history: [], crash: null, arenas: null };
    if (!this.meta.crash) this.meta.crash = { phase: 'bet', id: 1, betEnd: Date.now() + BET_MS, startAt: 0, crashAt: 0, endAt: 0, bets: {} };
    if (!this.meta.arenas) { this.meta.arenas = {}; ARENA_TIERS.forEach(t => this.meta.arenas[t] = { entry: t, players: [], endAt: 0, last: null }); }
    this.users = {};
    const all = await s.list({ prefix: 'u:' });
    for (const [k, v] of all) this.users[k.slice(2)] = v;
    this.dU = new Set(); this.dM = false;
  }
  touch(u) { this.dU.add(u.id); }
  saveMeta() { this.dM = true; }
  async flush() {
    const e = {};
    for (const id of this.dU) e['u:' + id] = this.users[id];
    if (this.dM) e.meta = this.meta;
    this.dU.clear(); this.dM = false;
    const keys = Object.keys(e);
    for (let i = 0; i < keys.length; i += 100) { const part = {}; keys.slice(i, i + 100).forEach(k => part[k] = e[k]); await this.state.storage.put(part); }
  }

  // ---------- users ----------
  getUser(tg) {
    const id = String(tg.id);
    let u = this.users[id];
    if (!u) { u = this.users[id] = { id, coins: this.meta.settings.startCoins, xp: 0, wagered: 0, won: 0, wins: 0, games: 0, bestMult: 0, lastWheel: 0, lastTag: 0, banned: false, created: Date.now(), name: '', username: '', photo: '' }; this.touch(u); }
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ') || tg.username || id;
    if (u.name !== name || (tg.photo_url && u.photo !== tg.photo_url)) { u.name = name; u.username = tg.username || ''; u.photo = tg.photo_url || u.photo || ''; this.touch(u); }
    return u;
  }
  pub(u) {
    return { id: u.id, name: u.name, photo: u.photo, coins: r2(u.coins), xp: u.xp, level: levelOf(u.xp), wagered: r2(u.wagered), won: r2(u.won), wins: u.wins, games: u.games, bestMult: u.bestMult, wheelIn: Math.max(0, u.lastWheel + DAY - Date.now()), tagIn: Math.max(0, u.lastTag + DAY - Date.now()), isAdmin: u.id === String(this.env.ADMIN_ID) };
  }
  addXp(u, a) { u.xp += Math.max(1, Math.floor(a)); }
  async tg(method, body) {
    if (!this.env.BOT_TOKEN) return null;
    try { const r = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, { method: 'POST', headers: JSONH, body: JSON.stringify(body) }); return (await r.json()).result; } catch { return null; }
  }

  // ---------- engines (lazy: advanced on every request) ----------
  nextCrashPoint() {
    const s = this.meta.settings;
    if (s.queue.length) { const v = s.queue.shift(); this.saveMeta(); return v; }
    const r = Math.random();
    let m = Math.floor(100 * (1 - s.edge) / (1 - r)) / 100;
    m = Math.min(Math.max(m, s.minMult), s.maxMult);
    return Math.max(1, r2(m));
  }
  settleBet(u, b, mult) {
    b.cashed = r2(mult);
    const win = r2(b.amount * mult);
    u.coins += win; u.won += win; u.wins += 1; u.bestMult = Math.max(u.bestMult, b.cashed);
    this.addXp(u, b.amount * 0.5 + 2); this.touch(u);
  }
  crashMult(now) { const c = this.meta.crash; return Math.exp(GROWTH * Math.max(0, now - c.startAt) / 1000); }
  advance() {
    const now = Date.now(), c = this.meta.crash;
    for (let i = 0; i < 6; i++) {
      if (c.phase === 'bet' && now >= c.betEnd) {
        if (!Object.keys(c.bets).length && now - c.betEnd > 15000) { c.betEnd = now + BET_MS; this.saveMeta(); break; } // idle: don't burn the queue
        c.crashAt = this.nextCrashPoint(); c.phase = 'run'; c.startAt = Math.max(c.betEnd, now - 60000); this.saveMeta(); continue;
      }
      if (c.phase === 'run') {
        const t = c.startAt + Math.log(c.crashAt) / GROWTH * 1000;
        if (now >= t) {
          for (const [uid, b] of Object.entries(c.bets)) {
            if (!b.cashed && b.auto && b.auto <= c.crashAt) this.settleBet(this.users[uid], b, b.auto);
            else if (!b.cashed) b.lost = true;
          }
          this.meta.history.unshift(c.crashAt); this.meta.history = this.meta.history.slice(0, 30);
          c.phase = 'crashed'; c.endAt = t; this.saveMeta(); continue;
        }
        // live auto-cashout when someone is polling
        const m = this.crashMult(now);
        for (const [uid, b] of Object.entries(c.bets)) if (!b.cashed && b.auto && m >= b.auto && b.auto <= c.crashAt) { this.settleBet(this.users[uid], b, b.auto); this.saveMeta(); }
        break;
      }
      if (c.phase === 'crashed' && now >= c.endAt + CRASHED_MS) {
        c.id++; c.phase = 'bet'; c.betEnd = Math.max(c.endAt + CRASHED_MS + BET_MS, now + (now - c.endAt > 60000 ? BET_MS : 0)); c.bets = {}; this.saveMeta(); continue;
      }
      break;
    }
    for (const a of Object.values(this.meta.arenas)) {
      if (a.players.length >= 2 && !a.endAt) { a.endAt = now + ARENA_WAIT; this.saveMeta(); }
      if (a.endAt && now >= a.endAt) {
        const prize = r2(a.entry * a.players.length * (1 - FEE));
        const w = a.players[Math.floor(Math.random() * a.players.length)];
        const wu = this.users[w.id]; wu.coins += prize; wu.won += prize; wu.wins++; this.addXp(wu, a.entry); this.touch(wu);
        a.players.forEach(p => { const pu = this.users[p.id]; pu.games++; this.addXp(pu, a.entry * 0.3); this.touch(pu); });
        a.last = { winner: w.name, prize, players: a.players.length, at: now }; a.players = []; a.endAt = 0; this.saveMeta();
      }
    }
  }

  // ---------- http ----------
  async fetch(req) {
    await this.ready;
    const url = new URL(req.url);
    if (url.pathname.startsWith('/setup/')) return this.setup(url);
    if (url.pathname.startsWith('/tg/')) return this.webhook(req, url);
    let out;
    try { out = await this.api(req, url); } catch (e) { console.error(e); out = json(500, { error: 'server error' }); }
    await this.flush();
    return out;
  }
  async setup(url) {
    if (url.pathname !== '/setup/' + this.env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
    const r1 = await this.tg('setWebhook', { url: `${url.origin}/tg/${this.env.WEBHOOK_SECRET}` });
    const r2_ = await this.tg('setChatMenuButton', { menu_button: { type: 'web_app', text: '🎮 بازی', web_app: { url: url.origin } } });
    return new Response(`webhook: ${JSON.stringify(r1)}\nmenu: ${JSON.stringify(r2_)}\nURL: ${url.origin}`);
  }
  async webhook(req, url) {
    if (url.pathname !== '/tg/' + this.env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
    const up = await req.json().catch(() => ({})); const m = up.message;
    if (m && m.text) {
      const id = String(m.from.id), [cmd, ...a] = m.text.split(/\s+/), origin = url.origin;
      if (cmd === '/start') await this.tg('sendMessage', { chat_id: id, text: '🚀 به بازی خوش آمدید! سکه‌ها مجازی و بدون ارزش مالی هستند.', reply_markup: { inline_keyboard: [[{ text: '🎮 ورود به بازی', web_app: { url: origin } }]] } });
      if (id === String(this.env.ADMIN_ID)) {
        if (cmd === '/give' || cmd === '/take') { const t = this.users[a[0]], n = Number(a[1]); if (t && n > 0) { t.coins = Math.max(0, r2(t.coins + (cmd === '/give' ? n : -n))); this.touch(t); await this.tg('sendMessage', { chat_id: id, text: `${t.name}: ${t.coins}` }); } }
        if (cmd === '/next') { this.meta.settings.queue.push(...a.map(Number).filter(n => n >= 1).map(r2)); this.saveMeta(); await this.tg('sendMessage', { chat_id: id, text: 'صف: ' + this.meta.settings.queue.join(', ') }); }
        if (cmd === '/clearnext') { this.meta.settings.queue = []; this.saveMeta(); }
      }
    }
    await this.flush();
    return new Response('ok');
  }
  async api(req, url) {
    let tgUser = await validateInitData(req.headers.get('x-init-data'), this.env.BOT_TOKEN);
    if (!tgUser && this.env.DEV === '1' && req.headers.get('x-dev-user')) tgUser = { id: req.headers.get('x-dev-user'), first_name: 'Dev ' + req.headers.get('x-dev-user') };
    if (!tgUser) return json(401, { error: 'unauthorized' });
    const u = this.getUser(tgUser);
    if (u.banned) return json(401, { error: 'banned' });
    this.advance();
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const key = `${req.method} ${url.pathname}`, isAdmin = u.id === String(this.env.ADMIN_ID);
    const S = this.meta.settings, c = this.meta.crash, now = Date.now();
    const bad = (m) => json(400, { error: m });
    if (key.includes('/api/admin/') && !isAdmin) return json(403, { error: 'forbidden' });

    switch (key) {
      case 'GET /api/me': return json(200, { user: this.pub(u), botUsername: this.env.BOT_USERNAME || '' });
      case 'GET /api/state': {
        const out = { user: this.pub(u), crash: { phase: c.phase, id: c.id, betLeft: Math.max(0, c.betEnd - now), mult: c.phase === 'run' ? r2(this.crashMult(now)) : (c.phase === 'crashed' ? c.crashAt : 1), crashAt: c.phase === 'crashed' ? c.crashAt : null, runningMs: c.phase === 'run' ? now - c.startAt : 0, growth: GROWTH, history: this.meta.history.slice(0, 15), players: Object.entries(c.bets).map(([id, x]) => ({ name: this.users[id].name, amount: x.amount, cashed: x.cashed || null })).slice(0, 30), my: c.bets[u.id] || null },
          arenas: Object.values(this.meta.arenas).map(a => ({ entry: a.entry, players: a.players.map(p => p.name), left: a.endAt ? Math.max(0, a.endAt - now) : null, joined: a.players.some(p => p.id === u.id), last: a.last })) };
        if (isAdmin) out.crash.adminNext = S.queue.slice(0, 5);
        return json(200, out);
      }
      case 'POST /api/crash/bet': {
        const amt = Math.floor(Number(body.amount));
        if (c.phase !== 'bet') return bad('ثبت شرط بسته است');
        if (!(amt >= 1 && amt <= 100000) || amt > u.coins) return bad('سکه کافی نیست');
        if (c.bets[u.id]) return bad('قبلاً شرط بسته‌اید');
        u.coins -= amt; u.wagered += amt; u.games++; this.addXp(u, amt * 0.2 + 1); this.touch(u);
        c.bets[u.id] = { amount: amt, auto: Number(body.auto) > 1 ? r2(Number(body.auto)) : 0 }; this.saveMeta();
        return json(200, { ok: true });
      }
      case 'POST /api/crash/cashout': {
        const b = c.bets[u.id];
        if (!b || b.cashed || c.phase !== 'run') return bad('امکان برداشت نیست');
        const m = this.crashMult(now);
        if (m >= c.crashAt) return bad('منفجر شد');
        this.settleBet(u, b, m); this.saveMeta(); return json(200, { ok: true, mult: b.cashed });
      }
      case 'POST /api/arena/join': {
        const a = this.meta.arenas[Number(body.entry)];
        if (!a) return bad('نامعتبر');
        if (a.players.some(p => p.id === u.id)) return bad('قبلاً وارد شده‌اید');
        if (a.endAt && a.endAt - now < 1500) return bad('دور در حال پایان است');
        if (u.coins < a.entry) return bad('سکه کافی نیست');
        u.coins -= a.entry; u.wagered += a.entry; a.players.push({ id: u.id, name: u.name }); this.touch(u); this.saveMeta();
        return json(200, { ok: true });
      }
      case 'POST /api/wheel': {
        if (now < u.lastWheel + DAY) return bad('هنوز زمان چرخش نرسیده');
        let r = Math.random() * 100, v = 2; for (const s of WHEEL) { if ((r -= s.w) < 0) { v = s.v; break; } }
        u.lastWheel = now; u.coins += v; u.won += v; this.addXp(u, 5); this.touch(u);
        return json(200, { prize: v, segments: WHEEL.map(s => s.v) });
      }
      case 'POST /api/tag': {
        if (now < u.lastTag + DAY) return bad('جایزه‌ی امروز گرفته شده');
        const bu = this.env.BOT_USERNAME; if (!bu) return bad('BOT_USERNAME تنظیم نشده');
        let name = u.name; const ch = await this.tg('getChat', { chat_id: u.id }); if (ch) name = [ch.first_name, ch.last_name].filter(Boolean).join(' ');
        if (!name.toLowerCase().includes(bu.toLowerCase())) return bad(`@${bu} را در اسم پروفایل‌تان بگذارید`);
        u.lastTag = now; u.coins += 5; u.won += 5; this.touch(u); return json(200, { ok: true, prize: 5 });
      }
      case 'GET /api/leaderboard': {
        const us = Object.values(this.users);
        const top = k => [...us].sort((a, b) => b[k] - a[k]).slice(0, 20).map(x => ({ name: x.name, photo: x.photo, level: levelOf(x.xp), value: r2(x[k]) }));
        return json(200, { circulation: top('wagered'), winners: top('won'), rich: top('coins') });
      }
      case 'GET /api/admin/users':
        return json(200, { users: Object.values(this.users).sort((a, b) => b.created - a.created).slice(0, 200).map(x => ({ id: x.id, name: x.name, username: x.username, coins: r2(x.coins), banned: x.banned })), settings: S });
      case 'POST /api/admin/coins': {
        const t = this.users[String(body.id)], amt = Number(body.amount);
        if (!t || !isFinite(amt)) return bad('کاربر یا مقدار نامعتبر');
        t.coins = Math.max(0, r2(t.coins + amt)); this.touch(t);
        await this.tg('sendMessage', { chat_id: t.id, text: `${amt >= 0 ? '➕' : '➖'} ${Math.abs(amt)} سکه ${amt >= 0 ? 'به کیف شما اضافه' : 'از کیف شما کم'} شد. موجودی: ${t.coins}` });
        return json(200, { ok: true, coins: t.coins });
      }
      case 'POST /api/admin/ban': { const t = this.users[String(body.id)]; if (!t) return bad('نامعتبر'); t.banned = !!body.banned; this.touch(t); return json(200, { ok: true }); }
      case 'POST /api/admin/queue': S.queue = (body.queue || []).map(Number).filter(n => n >= 1 && n <= 1000).map(r2).slice(0, 50); this.saveMeta(); return json(200, { ok: true, queue: S.queue });
      case 'POST /api/admin/settings':
        if (body.minMult >= 1) S.minMult = Number(body.minMult);
        if (body.maxMult >= 1.1) S.maxMult = Number(body.maxMult);
        if (body.edge >= 0 && body.edge < 0.5) S.edge = Number(body.edge);
        if (body.startCoins >= 0) S.startCoins = Number(body.startCoins);
        this.saveMeta(); return json(200, { ok: true, settings: S });
      case 'POST /api/admin/broadcast': {
        let n = 0; for (const x of Object.values(this.users).slice(0, 40)) { if (await this.tg('sendMessage', { chat_id: x.id, text: String(body.text || '').slice(0, 1000) })) n++; }
        return json(200, { sent: n });
      }
    }
    return json(404, { error: 'not found' });
  }
}
