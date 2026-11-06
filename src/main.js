import qrcode from 'qrcode-generator';
import { Mesh, K } from './mesh.js';
import { CATALOG, GROUPS } from './channels.js';
import { randomText } from './textgen.js';
import { rand, randHex, b64url, unb64url, median, pct, ms, now, kbps, kb } from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get: (k, d) => {
    try {
      return JSON.parse(localStorage.getItem('p2pm.' + k)) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem('p2pm.' + k, JSON.stringify(v));
    } catch {}
  },
};
const hhmm = (d = new Date()) => d.toTimeString().slice(0, 5);
const ICON = {
  invite: '<svg viewBox="0 0 24 24"><path d="M15 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="8.5" cy="7.5" r="3.5"/><path d="M19 8v6M22 11h-6"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};
const spark = (vals, w = 64, h = 18) => {
  if (vals.length < 2) return '';
  const mx = Math.max(...vals), mn = Math.min(...vals);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - mn) / (mx - mn || 1)) * (h - 2)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
};
const GROUP = Object.fromEntries(GROUPS.map((g) => [g.id, g]));
// сколько раз канал попал в тройку, из которой собрано сообщение
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
// рейтинг только среди активных каналов: сначала процент побед, при равенстве средний пинг
const wins = (useds, channels) => {
  const cnt = new Map();
  for (const u of useds) for (const id of u) cnt.set(id, (cnt.get(id) || 0) + 1);
  const live = channels.filter((c) => c.enabled && c.ready() && !c.dead);
  const top = live
    .map((c) => [c.id, cnt.get(c.id) || 0, avg(c.rtts) ?? 1e9])
    .sort((a, b) => b[1] - a[1] || a[2] - b[2])
    .map(([id, n]) => [id, n]);
  return { total: useds.length, top };
};

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Скопировано');
}
function toast(t) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = t;
  el.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('on'), 1800);
}

// ---------- комната из ссылки ----------
const hash = new URLSearchParams(location.hash.slice(1));
let keys = store.get('keys', {});
if (hash.get('c')) {
  try {
    keys = { ...keys, ...JSON.parse(new TextDecoder().decode(unb64url(hash.get('c')))) };
    store.set('keys', keys);
  } catch {}
}
let nick = store.get('nick', '') || 'Гость ' + randHex(2).toUpperCase();

const app = $('#app');
if (hash.get('r') && hash.get('k')) chat(hash.get('r'), unb64url(hash.get('k')));
else welcome();

function welcome() {
  app.innerHTML = `
  <div class="welcome">
    <img class="appicon" src="apple-touch-icon.png" alt="">
    <h1>P2P Mesh</h1>
    <p class="lead">Сообщение шифруется, делится по схеме Шамира на n долей и уходит сразу по n независимым каналам. Любые ${K} доли собирают его, две перехваченные ничего не раскрывают.</p>
    <div class="group"><label class="cell input"><span>Имя</span><input id="nick" maxlength="20" value="${esc(nick)}" autocomplete="off"></label></div>
    <button class="primary" id="create">Создать комнату</button>
    <p class="foot">Друг подключается по ссылке-приглашению</p>
  </div>`;
  $('#create').onclick = () => {
    nick = $('#nick').value.trim() || nick;
    store.set('nick', nick);
    const room = randHex(4);
    const key = rand(32);
    history.replaceState(null, '', `#r=${room}&k=${b64url(key)}`);
    chat(room, key, true);
  };
}

function inviteLink(room, key) {
  const ks = Object.fromEntries(Object.entries(keys).filter(([, v]) => v));
  let l = `${location.origin}${location.pathname}#r=${room}&k=${b64url(key)}`;
  if (Object.keys(ks).length) l += '&c=' + b64url(new TextEncoder().encode(JSON.stringify(ks)));
  return l;
}

// состояние канала для точки и подписи
function status(c) {
  if (!c) return { cls: 'soon', text: 'Скоро' };
  if (!c.enabled) return { cls: 'off', text: 'Выключен' };
  if (!c.ready()) return c.state === 'connecting' ? { cls: 'wait', text: 'Подключение…' } : { cls: 'down', text: 'Нет связи' };
  if (c.dead) return { cls: 'dead', text: c.deadWhy === 'loss' ? 'Исключён: доли теряются, повтор через 30 с' : 'Исключён: друг нас не слышит' };
  const t = now();
  const hears = t - (c.lastEcho || -1e9) < 15000;
  const heard = t - c.lastPeer < 20000;
  if (hears) return { cls: 'peer', text: heard ? 'Друг нас слышит' : 'Друг нас слышит, мы его нет' };
  return heard ? { cls: 'up', text: 'Мы слышим друга, он нас пока нет' } : { cls: 'up', text: 'Подключён, друга не слышно' };
}

function chat(room, key, fresh) {
  const ui = { auto: false, mode: 'para', size: 300, every: 1500 };
  const rows = new Map();
  const mesh = new Mesh({
    room,
    key,
    nick,
    keys,
    onChange: () => render(),
    onMessage: (box, late) => incoming(box, late),
    onHealth: (c, ok) => {
      const t = ok ? `${c.short || c.name} снова работает · ${hhmm()}` : `${c.short || c.name} не отвечает, исключён из рассылки · ${hhmm()}`;
      sys(t);
    },
  });

  app.innerHTML = `
  <header class="nav">
    <div class="navrow">
      <div class="titles"><h1>P2P Mesh</h1><p id="sub"></p></div>
      <div class="navbtns">
        <button class="icon" data-sheet="invite" aria-label="Пригласить">${ICON.invite}</button>
        <button class="icon" data-sheet="catalog" aria-label="Каталог каналов">${ICON.list}</button>
        <button class="icon" data-sheet="results" aria-label="Итоги">${ICON.chart}</button>
      </div>
    </div>
    <button class="summary" id="summary" data-sheet="results"></button>
    <div class="strip" id="strip"></div>
  </header>
  <main class="log" id="log"></main>
  <footer class="composer">
    <div class="autobar">
      <button class="pill" id="auto"></button>
      <div class="seg" id="mode"><button data-m="para">Абзацы</button><button data-m="words">Слова</button></div>
      <label class="size"><input type="range" id="size" min="20" max="10000" step="10" value="${ui.size}"><span id="sizev"></span></label>
      <button class="pill" id="every"></button>
    </div>
    <form class="inputrow" id="form">
      <input id="msg" placeholder="Сообщение" autocomplete="off" enterkeyhint="send">
      <button class="send" aria-label="Отправить">${ICON.up}</button>
    </form>
  </footer>
  <div class="scrim" id="scrim"></div>
  <section class="sheet" id="sheet" aria-modal="true" role="dialog">
    <div class="grabber"></div>
    <div class="sheethead"><button class="back" id="sheet-back" hidden>‹ Назад</button><h2 id="sheet-title"></h2><button class="done" id="sheet-x">Готово</button></div>
    <div class="sheetbody" id="sheet-body"></div>
  </section>
  <div id="toast" class="toast"></div>`;

  const log = $('#log');
  const sys = (t) => {
    const d = document.createElement('div');
    d.className = 'sys';
    d.textContent = t;
    log.append(d);
    log.scrollTop = log.scrollHeight;
  };
  sys(`Комната ${room.toUpperCase()} · ${mesh.channels.length} каналов · ${hhmm()}`);
  if (fresh) sys('Отправьте другу приглашение: кнопка вверху справа');

  // ---------- сообщения ----------
  const nm = (id) => mesh.byId[id]?.short || mesh.byId[id]?.name || id;
  function addMsg(id, text, mine, auto, who) {
    const d = document.createElement('div');
    d.className = 'msg' + (mine ? ' mine' : '') + (auto ? ' auto' : '');
    const short = auto && text.length > 220;
    d.innerHTML = `${!mine && who ? `<div class="who">${esc(who)}</div>` : ''}<div class="bubble">${esc(short ? text.slice(0, 220) + '…' : text)}</div><div class="cap"></div>`;
    d.querySelector('.bubble').onclick = () => openSheet('delivery', id);
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    log.append(d);
    while (log.children.length > 300) log.firstChild.remove();
    if (stick) log.scrollTop = log.scrollHeight;
    rows.set(id, d);
    if (rows.size > 300) rows.delete(rows.keys().next().value);
    return d;
  }
  function capMine(m) {
    const a = m.acks.size;
    const parts = [a >= K ? 'Доставлено' : a ? 'Доставляется' : 'Отправлено', `${a} из ${m.n}`];
    if (m.best5 != null) parts.push(`${ms(m.best5)} мс`);
    return parts.join(' · ');
  }
  const capIn = (box) => `Собрано из 3 · ${ms(box.ms)} мс · пришло ${box.pts.length} из ${box.n}`;

  function incoming(box, late) {
    let d = rows.get(box.id);
    if (!late && !d) d = addMsg(box.id, box.msg.text, false, box.msg.auto, box.msg.n || mesh.peerNick);
    if (d) d.querySelector('.cap').textContent = capIn(box);
  }

  function send(text, auto) {
    const r = mesh.send(text, auto);
    if (r.error) {
      if (!auto) toast('Нужно минимум 3 рабочих канала');
      return false;
    }
    addMsg(r.msg.id, text, true, auto);
    return true;
  }
  $('#form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#msg').value.trim();
    if (v && send(v, false)) $('#msg').value = '';
    wake();
  };

  // ---------- автотекст ----------
  let autoT;
  const everys = [500, 1000, 1500, 3000, 5000];
  const syncAuto = () => {
    $('#auto').classList.toggle('on', ui.auto);
    $('#auto').innerHTML = `${ui.auto ? ICON.stop : ICON.play}<span>Авто</span>`;
    $('#mode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === ui.mode));
    $('#sizev').textContent = ui.size;
    $('#every').textContent = (ui.every / 1000).toString().replace('.', ',') + ' с';
    clearInterval(autoT);
    if (ui.auto) autoT = setInterval(() => send(randomText(ui.mode, ui.size), true), ui.every);
  };
  $('#auto').onclick = () => ((ui.auto = !ui.auto), syncAuto(), wake());
  $('#mode').onclick = (e) => e.target.dataset.m && ((ui.mode = e.target.dataset.m), syncAuto());
  $('#every').onclick = () => ((ui.every = everys[(everys.indexOf(ui.every) + 1) % everys.length]), syncAuto());
  $('#size').oninput = (e) => ((ui.size = +e.target.value), ($('#sizev').textContent = ui.size));
  $('#size').onchange = syncAuto;
  syncAuto();

  $('#strip').onclick = (e) => {
    const t = e.target.closest('[data-ch]');
    if (t) openSheet('channel', t.dataset.ch);
  };

  // ---------- шапка ----------
  let wasOnline = false;
  function render() {
    const online = mesh.peerOnline();
    if (online !== wasOnline) {
      sys(online ? `${mesh.peerNick || 'Друг'} на связи · ${hhmm()}` : `${mesh.peerNick || 'Друг'} не отвечает · ${hhmm()}`);
      wasOnline = online;
    }
    const act = mesh.active().length;
    $('#sub').innerHTML = `<span class="dot ${online ? 'peer' : 'wait'}"></span>${online ? esc(mesh.peerNick || 'Друг') + ' на связи' : 'Ждём друга'} · <b class="${act >= K ? '' : 'bad'}">Шамир 3 из ${act}</b>`;
    const RANK = { peer: 0, up: 1, wait: 2, dead: 3, down: 4, off: 5 };
    $('#strip').innerHTML = [...mesh.channels]
      .sort((a, b) => RANK[status(a).cls] - RANK[status(b).cls] || (median(a.rtts) ?? 1e9) - (median(b.rtts) ?? 1e9))
      .map((c) => {
        const s = status(c);
        const val = !c.enabled ? 'выкл' : !c.ready() ? '—' : c.dead ? 'искл.' : c.last != null ? ms(c.last) : '···';
        return `<button class="chip ${s.cls}" data-ch="${c.id}"><span class="dot ${s.cls}"></span><span class="cn">${esc(c.short || c.name)}</span><span class="cv">${val}</span></button>`;
      })
      .join('');
    const h = mesh.history;
    const last = h[h.length - 1];
    const b5 = h.map((m) => m.best5 ?? m.t3).filter((v) => v != null);
    const wf = wins([...mesh.out.values()].map((m) => m.used).filter(Boolean), mesh.channels);
    const topLine = wf.total
      ? `<div class="top3"><span class="th">Побеждают у друга · ${wf.total} сообщ.</span>${wf.top
          .slice(0, 3)
          .map(([id, n], i) => {
            const p = Math.round((n / wf.total) * 100);
            return `<span class="w"><span class="wh"><span class="rank r${i + 1}">${i + 1}</span><span class="wn">${esc(nm(id))}</span></span><span class="bar"><span style="width:${p}%"></span></span><span class="wp">${p}% · ${n} из ${wf.total}</span><span class="wp">пинг ${ms(avg(mesh.byId[id]?.rtts || []))} мс</span></span>`;
          })
          .join('')}</div>`
      : '';
    $('#summary').innerHTML = (last
      ? `<div><small>3 из 5 лучших</small><b>${ms(last.best5 ?? last.t3)}<i> мс</i></b></div><div><small>Скорость 3/5</small><b>${kb([...h].reverse().find((m) => m.kbps != null)?.kbps)}<i> КБ/с</i></b></div><div><small>Трафик ↑ ↓</small><b class="sm">${kb(mesh.rate(mesh.tx))} · ${kb(mesh.rate(mesh.rx))}<i> КБ/с</i></b></div><div class="sp">${spark(b5.slice(-30))}</div>`
      : `<div class="hint">Замер начнётся с первого сообщения. «Авто» включает постоянный замер.</div>`) + topLine;
    for (const [id, d] of [...rows].slice(-40)) {
      const m = mesh.out.get(id);
      if (m) d.querySelector('.cap').textContent = capMine(m);
    }
    if (sheetOpen === 'results') resultsLive();
    if (sheetOpen === 'channel') channelLive();
    if (sheetOpen === 'delivery') sheetDelivery(sheetArg);
    if (sheetOpen === 'catalog') catalogLive();
  }

  // ---------- листы ----------
  let sheetOpen = null, sheetArg = null, sheetFrom = null;
  const sheet = $('#sheet');
  const pages = { invite: sheetInvite, catalog: sheetCatalog, results: sheetResults, channel: sheetChannel, delivery: sheetDelivery };
  function openSheet(name, arg, from = null) {
    sheetOpen = name;
    sheetArg = arg;
    sheetFrom = from;
    $('#sheet-back').hidden = !from;
    $('#sheet-body').onclick = null;
    pages[name](arg);
    $('#sheet-body').scrollTop = 0;
    sheet.classList.add('on');
    $('#scrim').classList.add('on');
  }
  const closeSheet = () => {
    sheetOpen = null;
    sheet.classList.remove('on');
    $('#scrim').classList.remove('on');
  };
  $('#sheet-x').onclick = closeSheet;
  $('#scrim').onclick = closeSheet;
  $('#sheet-back').onclick = () => openSheet(sheetFrom);
  document.querySelectorAll('[data-sheet]').forEach((b) => (b.onclick = () => openSheet(b.dataset.sheet)));

  function sheetInvite() {
    const link = inviteLink(room, key);
    const q = qrcode(0, 'L');
    q.addData(link);
    q.make();
    $('#sheet-title').textContent = 'Приглашение';
    $('#sheet-body').innerHTML = `
      <div class="qr">${q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
      <p class="note center">Отсканируйте камерой или отправьте ссылку. Ключ комнаты и ключи ящиков находятся в части ссылки после #, она не уходит на сервер.</p>
      <div class="group">
        <button class="cell action" id="cp">Скопировать ссылку</button>
        ${navigator.share ? '<button class="cell action" id="sh">Поделиться…</button>' : ''}
      </div>`;
    $('#cp').onclick = () => copy(link);
    if ($('#sh')) $('#sh').onclick = () => navigator.share({ title: 'P2P Mesh', text: 'Заходи в комнату', url: link }).catch(() => {});
  }

  const toggle = (id, on) => `<label class="switch"><input type="checkbox" data-tog="${id}" ${on ? 'checked' : ''}><span></span></label>`;
  function bindToggles(root) {
    root.querySelectorAll('[data-tog]').forEach((i) => {
      i.onclick = (e) => e.stopPropagation();
      i.onchange = () => {
        mesh.setEnabled(i.dataset.tog, i.checked);
        const c = mesh.byId[i.dataset.tog];
        toast(`${c.short || c.name} ${i.checked ? 'включён' : 'выключен'}`);
        sys(`Вы ${i.checked ? 'включили' : 'выключили'} ${c.short || c.name} · ${hhmm()}`);
      };
    });
  }
  const subline = (c) => {
    const s = status(c);
    return `${s.text}${c.last != null && c.ready() && c.enabled ? ' · ' + ms(c.last) + ' мс' : ''}`;
  };

  function sheetCatalog() {
    $('#sheet-title').textContent = 'Каналы';
    $('#sheet-body').innerHTML =
      `<p class="note">Нажмите на канал, чтобы узнать, как он работает. Нерабочие каналы исключаются сами и возвращаются, когда оживут. Переключатель выключает канал только у вас.</p>` +
      GROUPS.map((g) => {
        const items = CATALOG.filter((d) => d.group === g.id);
        return `<h3>${esc(g.title)} · ${esc(g.note)}</h3><div class="group">${items
          .map((d) => {
            const c = mesh.byId[d.id];
            const cls = d.soon ? 'soon' : c ? status(c).cls : 'off';
            const right = d.soon ? `<span class="badge ${d.group === 'fun' ? 'fun' : ''}">${d.group === 'fun' ? 'Мем · скоро' : 'Скоро'}</span>` : c ? toggle(d.id, c.enabled) : `<span class="link">Подключить ›</span>`;
            const sub = d.soon ? d.about : c ? subline(c) : 'Нужен ключ';
            return `<div class="cell row" data-open="${d.id}"><span class="dot ${cls}" data-dot="${d.id}"></span><div class="rt"><div>${esc(d.name)}</div><small data-st="${d.id}">${esc(sub)}</small></div>${right}</div>`;
          })
          .join('')}</div><p class="note">${esc(g.plain)}</p>`;
      }).join('');
    bindToggles($('#sheet-body'));
    $('#sheet-body').onclick = (e) => {
      const r = e.target.closest('[data-open]');
      if (r && !e.target.closest('.switch')) openSheet('channel', r.dataset.open, 'catalog');
    };
  }
  function catalogLive() {
    for (const c of mesh.channels) {
      const el = $(`[data-st="${c.id}"]`);
      if (!el) continue;
      el.textContent = subline(c);
      $(`[data-dot="${c.id}"]`).className = 'dot ' + status(c).cls;
      const t = $(`[data-tog="${c.id}"]`);
      if (t) t.checked = c.enabled;
    }
  }

  function sheetChannel(id) {
    const d = CATALOG.find((x) => x.id === id);
    const c = mesh.byId[id];
    $('#sheet-title').textContent = d.short || d.name;
    $('#sheet-body').innerHTML = `
      <div class="hero"><span class="dot big ${c ? status(c).cls : d.soon ? 'soon' : 'off'}" id="ch-dot"></span><div><div class="htitle">${esc(d.name)}</div><small>${esc(GROUP[d.group].title)}${d.host ? ' · ' + esc(d.host) : ''}</small></div></div>
      ${c ? `<div class="stats" id="ch-stats"></div>` : ''}
      ${c ? `<div class="group"><div class="cell row"><div class="rt"><div>Использовать канал</div><small>Только у вас: по каналу перестанем отправлять, приём останется</small></div>${toggle(id, c.enabled)}</div></div>` : ''}
      <h3>Простыми словами</h3>
      <div class="group"><div class="cell text">${esc(GROUP[d.group].plain)}</div></div>
      <h3>Как устроено</h3>
      <div class="group"><div class="cell text">${esc(d.about || '')}${d.soon ? `<p class="soonnote">${d.group === 'fun' ? 'Мемный канал, появится позже.' : 'Появится позже.'}</p>` : ''}</div></div>
      ${c ? `<h3>Состояние</h3><div class="group"><div class="cell text mono" id="ch-err"></div></div>` : ''}
      ${d.fields ? keyForm(d) : ''}`;
    bindToggles($('#sheet-body'));
    bindKeyForm(d);
    if (c) channelLive();
  }
  function channelLive() {
    const c = mesh.byId[sheetArg];
    if (!c || !$('#ch-stats')) return;
    const s = status(c);
    $('#ch-dot').className = 'dot big ' + s.cls;
    const loss = c.sent ? Math.round((c.lost / c.sent) * 100) + '%' : '—';
    $('#ch-stats').innerHTML =
      [['Последний', ms(c.last), 'мс'], ['Медиана', ms(median(c.rtts)), 'мс'], ['P95', ms(pct(c.rtts, 0.95)), 'мс'], ['Потери', loss, ''], ['Скорость', kb(kbps(c.bw)), 'КБ/с'], ['Отправлено', kb((c.txB || 0) / 1000), 'КБ']].map(([l, v, u]) => `<div><small>${l}</small><b>${v}<i>${u ? ' ' + u : ''}</i></b></div>`).join('') +
      `<div class="wide">${spark(c.rtts.slice(-40), 300, 40) || '<small>Пока нет замеров</small>'}</div>`;
    $('#ch-err').textContent = `${s.text}${c.err ? ' · ' + c.err : ''}\nОтправлено долей: ${c.sent}, подтверждено: ${c.acked}\nЗамеров RTT: ${c.rtts.length}${c.minGap ? `\nДоля не чаще раза в ${c.minGap / 1000} с` : ''}`;
    const t = $(`[data-tog="${c.id}"]`);
    if (t) t.checked = c.enabled;
  }

  function keyForm(d) {
    return `<h3>Ключи</h3><div class="group">${d.fields
      .map(([k, label, ph]) => `<label class="cell input"><span>${esc(label)}</span><input data-k="${k}" placeholder="${esc(ph)}" value="${esc(keys[d.id]?.[k] || '')}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`)
      .join('')}</div><p class="note">${esc(d.help)}</p><div class="group"><button class="cell action" id="ksave">Сохранить и переподключить</button>${keys[d.id] ? '<button class="cell action danger" id="kdel">Удалить ключи</button>' : ''}</div>`;
  }
  function bindKeyForm(d) {
    if (!$('#ksave')) return;
    $('#ksave').onclick = () => {
      const v = {};
      $('#sheet-body').querySelectorAll('[data-k]').forEach((i) => (v[i.dataset.k] = i.value.trim()));
      if (Object.values(v).some((x) => !x)) return toast('Заполните все поля');
      keys = { ...keys, [d.id]: v };
      store.set('keys', keys);
      history.replaceState(null, '', inviteLink(room, key).replace(location.origin + location.pathname, ''));
      location.reload();
    };
    if ($('#kdel'))
      $('#kdel').onclick = () => {
        delete keys[d.id];
        store.set('keys', keys);
        history.replaceState(null, '', `#r=${room}&k=${b64url(key)}`);
        location.reload();
      };
  }

  function sheetDelivery(id) {
    const m = mesh.out.get(id);
    const box = mesh.inbox.get(id);
    $('#sheet-title').textContent = 'Доставка';
    let head, list;
    if (m) {
      head = [['3 из 5 лучших', ms(m.best5), 'мс'], ['Скорость 3/5', kb(m.kbps), 'КБ/с'], [`3 из ${m.n}`, ms(m.t3), 'мс'], ['Подтверждено', `${m.acks.size}/${m.n}`, ''], ['Размер', kb(m.bytes / 1000), 'КБ']];
      list = [...m.sends].sort((a, b) => (a[1].rtt ?? 1e9) - (b[1].rtt ?? 1e9)).map(([cid, s]) => [cid, s.rtt != null ? `${ms(s.rtt)} мс · ${kb(s.b / (s.rtt / 2))} КБ/с` : s.lost ? 'Потеряна' : 'В пути…', m.used?.includes(cid)]);
    } else if (box) {
      head = [['Сборка', ms(box.ms), 'мс'], ['Пришло долей', `${box.pts.length}/${box.n}`, '']];
      list = [...box.pts].sort((a, b) => a.dt - b.dt).map((p) => [p.ch, '+' + ms(p.dt) + ' мс', box.used?.includes(p.ch)]);
    } else return;
    $('#sheet-body').innerHTML = `<div class="stats">${head.map(([l, v, u]) => `<div><small>${l}</small><b>${v}<i>${u ? ' ' + u : ''}</i></b></div>`).join('')}</div>
      <h3>Доли по каналам</h3><div class="group">${list.map(([cid, v, used]) => `<div class="cell row" data-open="${cid}"><span class="dot ${used ? 'peer' : 'up'}"></span><div class="rt"><div>${esc(nm(cid))}</div>${used ? '<small>Использована при сборке</small>' : ''}</div><span class="val">${v}</span></div>`).join('')}</div>
      <p class="note">${m ? 'Время туда и обратно: доля дошла, друг подтвердил её по тому же каналу.' : 'Время от первой пришедшей доли.'} Зелёные доли собрали сообщение.</p>`;
    $('#sheet-body').onclick = (e) => {
      const r = e.target.closest('[data-open]');
      if (r) openSheet('channel', r.dataset.open);
    };
  }

  function resultsText() {
    const h = mesh.history;
    const b5 = h.map((m) => m.best5).filter((v) => v != null);
    const t3 = h.map((m) => m.t3).filter((v) => v != null);
    const lines = [`P2P Mesh · комната ${room} · ${nick} · ${new Date().toLocaleString('ru')}`, `Сообщений: ${h.length}`, `3 из 5 лучших: медиана ${ms(median(b5))} мс, p95 ${ms(pct(b5, 0.95))} мс`, `3 из n:        медиана ${ms(median(t3))} мс, p95 ${ms(pct(t3, 0.95))} мс`, `Победители у друга: ${(() => { const w = wins([...mesh.out.values()].map((m) => m.used).filter(Boolean), mesh.channels); return w.top.slice(0, 5).map(([id, n]) => `${nm(id)} ${Math.round((n / w.total) * 100)}%`).join(', ') || '—'; })()}`, `Скорость 3/5: медиана ${kb(median(h.map((m) => m.kbps).filter((v) => v != null)))} КБ/с`, '', 'Канал            Статус  Мед    P95    КБ/с   Потери Замеров'];
    const sorted = [...mesh.channels].sort((a, b) => (median(a.rtts) ?? 1e9) - (median(b.rtts) ?? 1e9));
    for (const c of sorted) {
      const st = !c.enabled ? 'выкл' : c.ready() ? 'ok' : 'нет';
      const loss = c.sent ? Math.round((c.lost / c.sent) * 100) + '%' : '--';
      lines.push(`${(c.short || c.name).padEnd(16)} ${st.padEnd(7)} ${ms(median(c.rtts)).padEnd(6)} ${ms(pct(c.rtts, 0.95)).padEnd(6)} ${kb(kbps(c.bw)).padEnd(6)} ${loss.padEnd(6)} ${c.rtts.length}${c.err ? '  ' + c.err : ''}`);
    }
    lines.push('', 'RTT туда и обратно, мс. 3 из 5 лучших = третья доля среди 5 каналов с лучшей медианой. Скорость = байты доли / время в одну сторону (RTT/2).');
    return lines.join('\n');
  }
  function sheetResults() {
    $('#sheet-title').textContent = 'Итоги';
    $('#sheet-body').innerHTML = `<div class="stats" id="r-stats"></div><h3>Победители у друга</h3><div class="group" id="r-wf"></div><p class="note">Только активные каналы. Сначала по тому, как часто канал попадал в тройку, из которой друг собрал ваше сообщение, при равенстве по среднему пингу.</p><h3>Победители у вас</h3><div class="group" id="r-wm"></div><p class="note">То же для сообщений друга, собранных у вас.</p><h3>Каналы: сначала рабочие, по скорости</h3><div class="group" id="r-list"></div><div class="group"><button class="cell action" id="cpr">Скопировать итоги</button></div>`;
    $('#cpr').onclick = () => copy(resultsText());
    $('#sheet-body').onclick = (e) => {
      const r = e.target.closest('[data-open]');
      if (r) openSheet('channel', r.dataset.open, 'results');
    };
    resultsLive();
  }
  function resultsLive() {
    const h = mesh.history;
    const b5 = h.map((m) => m.best5 ?? m.t3).filter((v) => v != null);
    const t3 = h.map((m) => m.t3).filter((v) => v != null);
    const sp = h.map((m) => m.kbps).filter((v) => v != null);
    $('#r-stats').innerHTML = `<div><small>3 из 5 · медиана</small><b>${ms(median(b5))}<i> мс</i></b></div><div><small>Скорость 3/5 · медиана</small><b>${kb(median(sp))}<i> КБ/с</i></b></div><div><small>Трафик ↑ ↓</small><b>${kb(mesh.rate(mesh.tx))} · ${kb(mesh.rate(mesh.rx))}<i> КБ/с</i></b></div><div><small>3 из 5 · p95</small><b>${ms(pct(b5, 0.95))}<i> мс</i></b></div><div><small>3 из n · медиана</small><b>${ms(median(t3))}<i> мс</i></b></div><div><small>Сообщений</small><b>${h.length}</b></div><div class="wide">${spark(b5.slice(-60), 300, 40) || '<small>Пока нет замеров</small>'}</div>`;
    const winList = (w) =>
      w.total
        ? w.top.map(([id, n], i) => `<div class="cell row" data-open="${id}"><span class="rank">${i + 1}</span><div class="rt"><div>${esc(nm(id))}</div><small>${n} из ${w.total} · средний пинг ${ms(avg(mesh.byId[id]?.rtts || []))} мс</small></div><span class="val">${Math.round((n / w.total) * 100)}%</span></div>`).join('')
        : '<div class="cell"><small class="muted">Пока нет собранных сообщений</small></div>';
    $('#r-wf').innerHTML = winList(wins([...mesh.out.values()].map((m) => m.used).filter(Boolean), mesh.channels));
    $('#r-wm').innerHTML = winList(wins([...mesh.inbox.values()].map((b) => b.used).filter(Boolean), mesh.channels));
    const RANK = { peer: 0, up: 1, wait: 2, dead: 3, down: 4, off: 5 };
    const sorted = [...mesh.channels].sort((a, b) => RANK[status(a).cls] - RANK[status(b).cls] || (median(a.rtts) ?? 1e9) - (median(b.rtts) ?? 1e9));
    $('#r-list').innerHTML = sorted
      .map((c) => {
        const loss = c.sent ? Math.round((c.lost / c.sent) * 100) : null;
        return `<div class="cell row" data-open="${c.id}"><span class="dot ${status(c).cls}"></span><div class="rt"><div>${esc(c.short || c.name)}</div><small>p95 ${ms(pct(c.rtts, 0.95))} мс · потери ${loss == null ? '—' : loss + '%'}</small></div><span class="val">${ms(median(c.rtts))} мс<br><small>${kb(kbps(c.bw))} КБ/с</small></span></div>`;
      })
      .join('');
  }

  // ---------- экран не гаснет ----------
  let lock;
  async function wake() {
    try {
      if (!lock && navigator.wakeLock) {
        lock = await navigator.wakeLock.request('screen');
        lock.onrelease = () => (lock = null);
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && ui.auto && wake());

  mesh.start();
  render();
  window.mesh = mesh;
  if (fresh) setTimeout(() => openSheet('invite'), 300);
}

if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
