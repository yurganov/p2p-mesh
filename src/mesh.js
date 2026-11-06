// Движок: каналы, кадры, Шамир 3/n, подтверждения и замер скорости.
import { CATALOG } from './channels.js';
import { split, combine } from './shamir.js';
import { sha256, bytesToHex, utf8ToBytes, randHex, b64, unb64, encrypt, decrypt, now, median } from './util.js';

export const K = 3;
const ACK_TIMEOUT = 10000;
const PEER_TIMEOUT = 20000;
const HEAR_TIMEOUT = 15000; // сколько ждём эха, прежде чем исключить канал
const RETRY_DEAD = 30000; // через сколько снова пробуем канал, исключённый за потери

export class Mesh {
  constructor({ room, key, nick, keys, disabled, onChange, onMessage, onHealth }) {
    Object.assign(this, { room, key, nick, onChange, onMessage, onHealth });
    this.topic = bytesToHex(sha256(utf8ToBytes(`p2pmesh|${room}|${bytesToHex(key)}`))).slice(0, 24);
    this.me = randHex(4);
    this.peer = null;
    this.peerNick = '';
    this.out = new Map(); // мои сообщения: id → состояние доставки
    this.inbox = new Map(); // входящие доли: id → { pts, ... }
    this.sigSeen = new Set();
    this.history = []; // { t3, best5 } по отправленным
    this.channels = CATALOG.filter((d) => !d.soon && (!d.fields || keys[d.id])).map((d) => {
      const c = new d.kind({ ...d, cfg: keys[d.id] });
      if (disabled?.includes(d.id)) c.enabled = false;
      return c;
    });
    this.byId = Object.fromEntries(this.channels.map((c) => [c.id, c]));
    this.rtc = this.byId.webrtc;
    this.lastRtcTry = 0;
    this.tx = [];
    this.rx = [];
  }

  start() {
    const ctx = {
      topic: this.topic,
      me: this.me,
      peer: () => this.peer,
      frame: (ch, s) => this.onFrame(ch, s),
      changed: () => this.changed(),
      signal: (to, m) => this.broadcast({ t: 'sig', to, m, sid: randHex(4) }, (c) => c !== this.rtc),
    };
    for (const c of this.channels) c.start(ctx);
    this.tick = setInterval(() => this.loop(), 1000);
  }

  changed() {
    if (this.raf) return;
    this.raf = setTimeout(() => {
      this.raf = 0;
      this.onChange?.();
    }, 200);
  }

  frame(o) {
    return JSON.stringify({ ...o, f: this.me });
  }

  broadcast(o, filter = () => true) {
    const s = this.frame(o);
    for (const c of this.channels) if (c.enabled && c.ready() && filter(c)) c.send(s);
  }

  loop() {
    const t = now();
    for (const c of this.channels) {
      if (c.enabled && c.ready() && t - c.lastHi > c.hiEvery) {
        c.lastHi = t;
        c.send(this.frame({ t: 'hi', nk: this.nick, ts: t }));
      }
    }
    for (const m of this.out.values()) {
      for (const [id, s] of m.sends) {
        if (!s.done && t - s.t > ACK_TIMEOUT) {
          s.done = true;
          s.lost = true;
          this.byId[id].lost++;
          this.byId[id].lossStreak = (this.byId[id].lossStreak || 0) + 1;
        }
      }
    }
    this.health(t);
    if (this.rtc && this.peer && this.me < this.peer && !this.rtc.ready() && !this.rtc.busy() && this.peerOnline() && t - this.lastRtcTry > 3000) {
      this.lastRtcTry = t;
      this.rtc.connect(this.peer);
    }
    this.changed();
  }

  // Нерабочие каналы исключаются из рассылки сами: друг нас не слышит или доли теряются.
  health(t) {
    const online = this.peerOnline();
    for (const c of this.channels) {
      if (!c.ready()) {
        c.upAt = 0;
        continue;
      }
      if (!c.upAt) c.upAt = t;
      if (!c.enabled) continue;
      if (c.dead) {
        if (c.deadWhy === 'loss' && t - c.deadAt > RETRY_DEAD) this.revive(c);
        continue;
      }
      const silent = online && t - c.upAt > HEAR_TIMEOUT && t - (c.lastEcho || 0) > HEAR_TIMEOUT;
      if (silent || c.lossStreak >= 3) {
        c.dead = true;
        c.deadAt = t;
        c.deadWhy = silent ? 'silent' : 'loss';
        this.onHealth?.(c, false);
      }
    }
  }
  revive(c) {
    c.dead = false;
    c.lossStreak = 0;
    this.onHealth?.(c, true);
  }
  heard(c, t) {
    c.lastEcho = t;
    if (c.dead && c.deadWhy === 'silent') this.revive(c);
  }

  // скользящий счётчик байт за 5 с
  count(arr, b, t) {
    arr.push([t, b]);
    while (arr.length && t - arr[0][0] > 5000) arr.shift();
  }
  rate(arr) {
    const t = now();
    while (arr.length && t - arr[0][0] > 5000) arr.shift();
    return arr.reduce((a, [, b]) => a + b, 0) / 5000; // байт/мс = КБ/с
  }

  peerOnline() {
    const t = now();
    return this.channels.some((c) => t - c.lastPeer < PEER_TIMEOUT);
  }

  addRtt(c, v) {
    c.last = v;
    c.rtts.push(v);
    if (c.rtts.length > 120) c.rtts.shift();
  }

  onFrame(ch, s) {
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      return;
    }
    if (!o || o.f === this.me || (o.to && o.to !== this.me)) return;
    const t = now();
    if (this.peer !== o.f) {
      this.peer = o.f;
      this.lastRtcTry = 0;
    }
    ch.lastPeer = t;
    if (o.nk) this.peerNick = o.nk;
    this.count(this.rx, s.length, t);
    switch (o.t) {
      case 'hi':
        ch.send(this.frame({ t: 'ho', ts: o.ts, to: o.f }));
        break;
      case 'ho':
        this.addRtt(ch, t - o.ts);
        this.heard(ch, t);
        break;
      case 's':
        ch.send(this.frame({ t: 'a', id: o.id, x: o.x, to: o.f }));
        this.gotShare(ch, o, t);
        break;
      case 'a':
        this.heard(ch, t);
        ch.lossStreak = 0;
        this.gotAck(ch, o, t);
        break;
      case 'ok': {
        const m = this.out.get(o.id);
        if (m && !m.used) {
          m.used = o.used;
          m.assembleMs = o.ms;
        }
        break;
      }
      case 'sig':
        if (this.sigSeen.has(o.sid)) return;
        this.sigSeen.add(o.sid);
        this.rtc?.signal(o.f, o.m);
        break;
    }
    this.changed();
  }

  active() {
    const t = now();
    return this.channels.filter((c) => c.enabled && !c.dead && c.ready() && t - c.lastShare >= c.minGap);
  }

  send(text, auto = false) {
    const act = this.active();
    if (act.length < K) return { error: `нужно минимум ${K} канала, готово ${act.length}` };
    const id = randHex(5);
    const blob = encrypt(this.key, { text, n: this.nick, auto, at: Date.now() });
    const shares = split(blob, act.length, K);
    const t = now();
    const m = { id, mine: true, text, auto, n: act.length, t0: t, sends: new Map(), acks: new Map(), used: null, at: Date.now() };
    m.bytes = blob.length;
    act.forEach((c, i) => {
      const { x, y } = shares[i];
      const f = this.frame({ t: 's', id, x, k: K, n: act.length, d: b64(y) });
      m.sends.set(c.id, { x, t, b: f.length });
      c.send(f);
      c.txB = (c.txB || 0) + f.length;
      this.count(this.tx, f.length, t);
      c.sent++;
      c.lastShare = t;
    });
    this.out.set(id, m);
    if (this.out.size > 400) this.out.delete(this.out.keys().next().value);
    this.changed();
    return { msg: m };
  }

  gotAck(ch, o, t) {
    const m = this.out.get(o.id);
    const s = m?.sends.get(ch.id);
    if (!s || s.done) return;
    s.done = true;
    const rtt = t - s.t;
    s.rtt = rtt;
    m.acks.set(ch.id, rtt);
    ch.acked++;
    this.addRtt(ch, rtt);
    ch.bw.push([s.b, rtt / 2]);
    if (ch.bw.length > 30) ch.bw.shift();
    this.score(m);
  }

  // 3/n: время третьего подтверждения. 3/5 лучших: третье среди 5 каналов с лучшей медианой.
  score(m) {
    const all = [...m.acks.values()].sort((a, b) => a - b);
    if (all.length >= K) m.t3 = all[K - 1];
    const best = [...m.sends.keys()]
      .map((id) => this.byId[id])
      .filter((c) => c.rtts.length)
      .sort((a, b) => median(a.rtts) - median(b.rtts))
      .slice(0, 5)
      .map((c) => m.acks.get(c.id))
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    if (best.length >= K) m.best5 = best[K - 1];
    if (m.best5 != null) m.kbps = m.bytes / (m.best5 / 2);
    if (m.t3 != null && !m.scored) {
      m.scored = true;
      this.history.push(m);
      if (this.history.length > 120) this.history.shift();
    }
  }

  gotShare(ch, o, t) {
    let box = this.inbox.get(o.id);
    if (!box) {
      box = { id: o.id, n: o.n, pts: [], t0: t, done: false };
      this.inbox.set(o.id, box);
      if (this.inbox.size > 400) this.inbox.delete(this.inbox.keys().next().value);
    }
    if (box.pts.some((p) => p.x === o.x)) return;
    box.pts.push({ x: o.x, y: unb64(o.d), ch: ch.id, dt: t - box.t0 });
    if (box.done) return void this.onMessage?.(box, true);
    if (box.pts.length < K) return;
    const res = this.tryCombine(box.pts);
    if (!res) return;
    box.done = true;
    box.msg = res.msg;
    box.used = res.used.map((p) => p.ch);
    box.ms = t - box.t0;
    this.broadcast({ t: 'ok', id: o.id, used: box.used, ms: box.ms, to: o.f }, (c) => !c.minGap);
    this.onMessage?.(box, false);
  }

  tryCombine(pts) {
    const n = pts.length;
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        for (let c = b + 1; c < n; c++) {
          const used = [pts[a], pts[b], pts[c]];
          try {
            return { msg: decrypt(this.key, combine(used)), used };
          } catch {}
          if (n === 3) return null;
        }
    return null;
  }

  // Выключение только у себя: по каналу перестаём отправлять, приём остаётся.
  setEnabled(id, on) {
    const c = this.byId[id];
    if (!c) return;
    c.enabled = on;
    if (on) this.revive(c);
    this.changed();
  }
}
