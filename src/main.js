import qrcode from 'qrcode-generator';
import { Mesh, K } from './mesh.js';
import { CATALOG, GROUPS } from './channels.js';
import { randomText } from './textgen.js';
import { rand, randHex, b64url, unb64url, median, pct, ms, now } from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
const clock = (d = new Date()) => d.toTimeString().slice(0, 8);
const SPARK = '▁▂▃▄▅▆▇█';
const spark = (vals) => {
  if (!vals.length) return '';
  const mx = Math.max(...vals), mn = Math.min(...vals);
  return vals.map((v) => SPARK[Math.round(((v - mn) / (mx - mn || 1)) * 7)]).join('');
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
  toast('СКОПИРОВАНО');
}
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('on'), 1600);
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
let nick = store.get('nick', '') || 'гость-' + randHex(2);

const app = $('#app');
if (hash.get('r') && hash.get('k')) chat(hash.get('r'), unb64url(hash.get('k')));
else welcome();

function welcome() {
  app.innerHTML = `
  <div class="welcome">
    <pre class="logo">
 ___ ___ ___
| _ \\_  ) _ \\
|  _// /|  _/
|_| /___|_|  MESH</pre>
    <p class="amb">ТЕРМИНАЛ МНОГОКАНАЛЬНОЙ СВЯЗИ</p>
    <p class="dim">Сообщение шифруется, делится по Шамиру на n долей и уходит по n каналам сразу. Любые ${K} доли собирают его обратно, 2 перехваченные ничего не раскрывают.</p>
    <label class="field"><span>ПОЗЫВНОЙ</span><input id="nick" maxlength="20" value="${esc(nick)}" autocomplete="off"></label>
    <button class="btn big" id="create">[ СОЗДАТЬ КОМНАТУ ]</button>
    <p class="dim small">Друг подключается по ссылке-приглашению.<span class="cursor">▌</span></p>
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

function chat(room, key, fresh) {
  const ui = { open: store.get('panel', false), both: false, auto: false, mode: 'para', size: 300, every: 1500 };
  const rows = new Map(); // id сообщения → элемент
  const mesh = new Mesh({
    room,
    key,
    nick,
    keys,
    onChange: () => render(),
    onMessage: (box, late) => incoming(box, late),
  });

  app.innerHTML = `
  <header class="top">
    <div class="brand">P2P-MESH<span class="cursor">▌</span></div>
    <div class="peer" id="peer"></div>
  </header>
  <nav class="tabs">
    <button class="btn" data-sheet="invite">ПРИГЛАСИТЬ</button>
    <button class="btn" data-sheet="catalog">КАТАЛОГ</button>
    <button class="btn" data-sheet="results">ИТОГИ</button>
  </nav>
  <section class="panel">
    <button class="ptitle" id="ptoggle"></button>
    <div id="tiles" class="tiles"></div>
    <div class="score" id="score"></div>
  </section>
  <main class="log" id="log"></main>
  <footer class="compose">
    <div class="autobar">
      <button class="chip" id="auto">АВТОТЕКСТ</button>
      <button class="chip" id="mode"></button>
      <label class="size"><input type="range" id="size" min="20" max="2000" step="10" value="${ui.size}"><span id="sizev"></span></label>
      <button class="chip" id="every"></button>
    </div>
    <form class="line" id="form">
      <span class="prompt">&gt;</span>
      <input id="msg" placeholder="сообщение" autocomplete="off" enterkeyhint="send">
      <button class="btn send" aria-label="Отправить">⏎</button>
    </form>
  </footer>
  <div class="sheet" id="sheet"><div class="sheet-in"><div class="sheet-head"><span id="sheet-title"></span><button class="btn" id="sheet-x">[X]</button></div><div id="sheet-body"></div></div></div>
  <div id="toast" class="toast"></div>`;

  const log = $('#log');
  const sys = (t, cls = 'dim') => {
    const d = document.createElement('div');
    d.className = 'sys ' + cls;
    d.textContent = `[${clock()}] *** ${t}`;
    log.append(d);
    log.scrollTop = log.scrollHeight;
  };
  sys(`КОМНАТА ${room.toUpperCase()} · ВЫ ${nick.toUpperCase()} · КАНАЛОВ ${mesh.channels.length}`, 'amb');
  sys(fresh ? 'ОТПРАВЬТЕ ДРУГУ ПРИГЛАШЕНИЕ: КНОПКА «ПРИГЛАСИТЬ»' : 'ПОДКЛЮЧАЮСЬ К КАНАЛАМ…');

  // ---------- сообщения ----------
  function addMsg(id, who, text, mine, auto) {
    const d = document.createElement('div');
    d.className = 'msg' + (mine ? ' mine' : '') + (auto ? ' auto' : '');
    const short = auto && text.length > 160;
    d.innerHTML = `<div class="mline"><span class="who">[${clock()}] &lt;${esc(who)}&gt;</span> <span class="txt">${esc(short ? text.slice(0, 160) + '…' : text)}</span></div><div class="meta"></div>`;
    if (short) d.querySelector('.txt').onclick = (e) => (e.target.textContent = text);
    d.querySelector('.meta').onclick = () => d.classList.toggle('open');
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.append(d);
    while (log.children.length > 300) log.firstChild.remove();
    if (stick) log.scrollTop = log.scrollHeight;
    rows.set(id, d);
    if (rows.size > 300) rows.delete(rows.keys().next().value);
    return d;
  }
  const nm = (id) => mesh.byId[id]?.name || id;

  function metaMine(m) {
    const acked = m.acks.size;
    const parts = [`${acked >= K ? '✓✓' : acked ? '✓' : '…'} ${acked}/${m.n} долей`];
    if (m.t3 != null) parts.push(`3/${m.n}: ${ms(m.t3)}мс`);
    if (m.best5 != null) parts.push(`3/5 лучш.: ${ms(m.best5)}мс`);
    if (m.used) parts.push(`собрано у друга: ${m.used.map(nm).join(' + ')}`);
    const detail = [...m.sends].map(([id, s]) => `${nm(id).padEnd(18)} ${s.rtt != null ? ms(s.rtt) + 'мс' : s.lost ? 'ПОТЕРЯНА' : '…'}`).join('\n');
    return `↳ ${parts.join(' · ')}<pre class="detail">${esc(detail)}</pre>`;
  }
  function metaIn(box) {
    const parts = [`собрано из ${K}/${box.n} за ${ms(box.ms)}мс: ${box.used.map(nm).join(' + ')}`, `пришло ${box.pts.length}/${box.n}`];
    const detail = box.pts.map((p) => `${nm(p.ch).padEnd(18)} +${ms(p.dt)}мс${box.used.includes(p.ch) ? '  ◆' : ''}`).join('\n');
    return `↳ ${parts.join(' · ')}<pre class="detail">${esc(detail)}</pre>`;
  }

  function incoming(box, late) {
    let d = rows.get(box.id);
    if (!late && !d) d = addMsg(box.id, box.msg.n || mesh.peerNick || 'друг', box.msg.text, false, box.msg.auto);
    if (d) d.querySelector('.meta').innerHTML = metaIn(box);
  }

  function send(text, auto) {
    const r = mesh.send(text, auto);
    if (r.error) {
      if (!auto) sys('ОШИБКА: ' + r.error.toUpperCase(), 'red');
      return false;
    }
    addMsg(r.msg.id, nick, text, true, auto);
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
  const modes = { para: 'АБЗАЦЫ', words: 'СЛОВА' };
  const everys = [500, 1000, 1500, 3000, 5000];
  const syncAuto = () => {
    $('#auto').classList.toggle('on', ui.auto);
    $('#auto').textContent = ui.auto ? '■ АВТО' : '▶ АВТОТЕКСТ';
    $('#mode').textContent = modes[ui.mode];
    $('#sizev').textContent = ui.size + 'с';
    $('#every').textContent = (ui.every / 1000).toString().replace('.', ',') + 'с';
    clearInterval(autoT);
    if (ui.auto) autoT = setInterval(() => send(randomText(ui.mode, ui.size), true), ui.every);
  };
  $('#auto').onclick = () => {
    ui.auto = !ui.auto;
    syncAuto();
    wake();
  };
  $('#mode').onclick = () => ((ui.mode = ui.mode === 'para' ? 'words' : 'para'), syncAuto());
  $('#every').onclick = () => ((ui.every = everys[(everys.indexOf(ui.every) + 1) % everys.length]), syncAuto());
  $('#size').oninput = (e) => ((ui.size = +e.target.value), ($('#sizev').textContent = ui.size + 'с'));
  $('#size').onchange = syncAuto;
  syncAuto();

  $('#ptoggle').onclick = () => {
    ui.open = !ui.open;
    store.set('panel', ui.open);
    render();
  };
  $('#tiles').onclick = (e) => {
    const t = e.target.closest('[data-ch]');
    if (!t) return;
    const c = mesh.byId[t.dataset.ch];
    mesh.setEnabled(c.id, !c.enabled, ui.both);
    toast(`${c.name} ${c.enabled ? 'ВКЛ' : 'ВЫКЛ'}${ui.both ? ' У ОБОИХ' : ''}`);
  };

  // ---------- шапка и плитки каналов ----------
  let wasOnline = false;
  function render() {
    const online = mesh.peerOnline();
    if (online !== wasOnline) {
      sys(online ? `${(mesh.peerNick || 'ДРУГ').toUpperCase()} НА СВЯЗИ` : 'ДРУГ ПРОПАЛ СО СВЯЗИ', online ? 'amb' : 'red');
      wasOnline = online;
    }
    const act = mesh.active().length;
    const t = now();
    $('#peer').innerHTML = `<span class="${act >= K ? '' : 'red'}">SHAMIR ${K}/${act}</span> <span class="${online ? 'amb' : 'dim'}">${online ? '● ' + esc(mesh.peerNick || 'ДРУГ').toUpperCase() : '○ ЖДУ ДРУГА'}</span>`;
    const up = mesh.channels.filter((c) => c.ready()).length;
    $('#ptoggle').textContent = `[${ui.open ? '−' : '+'}] КАНАЛЫ ${up}/${mesh.channels.length} ${ui.open ? '' : '· ПОДРОБНО'}`;
    $('#tiles').className = 'tiles' + (ui.open ? ' open' : '');
    $('#tiles').innerHTML =
      mesh.channels
        .map((c) => {
          const st = !c.enabled ? 'off' : c.ready() ? (t - c.lastPeer < 20000 ? 'peer' : 'up') : c.state === 'connecting' ? 'wait' : 'down';
          const med = median(c.rtts);
          const loss = c.sent ? Math.round((c.lost / c.sent) * 100) : null;
          const icon = { off: '○', peer: '●', up: '◐', wait: '◌', down: '✕' }[st];
          const val = !c.enabled ? 'ВЫКЛ' : st === 'down' ? 'НЕТ' : c.last != null ? ms(c.last) : '··';
          if (!ui.open) return `<button class="tile ${st}" data-ch="${c.id}"><b>${icon} ${esc((c.short || c.name).slice(0, 10))}</b><i>${val}</i></button>`;
          return `<button class="row ${st}" data-ch="${c.id}"><span class="rn">${icon} ${esc(c.name)}</span><span>${val}</span><span>${ms(med)}</span><span>${ms(pct(c.rtts, 0.95))}</span><span>${loss == null ? '--' : loss + '%'}</span><span class="rs">${esc(c.err || c.host || '')} ${spark(c.rtts.slice(-16))}</span></button>`;
        })
        .join('') +
      (ui.open
        ? `<div class="rowhead"><span>КАНАЛ</span><span>ПОСЛ</span><span>МЕД</span><span>P95</span><span>ПОТ</span></div><label class="bothsw"><input type="checkbox" id="both" ${ui.both ? 'checked' : ''}> ВЫКЛЮЧАТЬ У ОБОИХ</label>`
        : '');
    const both = $('#both');
    if (both) both.onchange = (e) => (ui.both = e.target.checked);
    const h = mesh.history;
    const last = h[h.length - 1];
    $('#score').innerHTML = last
      ? `<span>3/${last.n}: <b>${ms(last.t3)}</b>мс</span><span>3/5 ЛУЧШ: <b>${ms(last.best5)}</b>мс</span><span>МЕД 3/5: ${ms(median(h.map((m) => m.best5).filter((v) => v != null)))}мс</span><span class="sp">${spark(h.slice(-24).map((m) => m.best5 ?? m.t3))}</span>`
      : `<span class="dim">ЗАМЕР НАЧНЁТСЯ С ПЕРВЫМ СООБЩЕНИЕМ · ▶ АВТОТЕКСТ = ПОСТОЯННЫЙ ЗАМЕР</span>`;
    for (const [id, d] of [...rows].slice(-40)) {
      const m = mesh.out.get(id);
      if (m) d.querySelector('.meta').innerHTML = metaMine(m);
    }
    if (sheetOpen === 'results') sheetResults();
  }

  // ---------- листы ----------
  let sheetOpen = null;
  const sheet = $('#sheet');
  function openSheet(name) {
    sheetOpen = name;
    sheet.classList.add('on');
    ({ invite: sheetInvite, catalog: sheetCatalog, results: sheetResults })[name]();
  }
  $('#sheet-x').onclick = () => ((sheetOpen = null), sheet.classList.remove('on'));
  document.querySelectorAll('[data-sheet]').forEach((b) => (b.onclick = () => openSheet(b.dataset.sheet)));

  function sheetInvite() {
    const link = inviteLink(room, key);
    const q = qrcode(0, 'L');
    q.addData(link);
    q.make();
    $('#sheet-title').textContent = 'ПРИГЛАШЕНИЕ';
    $('#sheet-body').innerHTML = `
      <div class="qr">${q.createSvgTag({ cellSize: 4, margin: 3, scalable: true })}</div>
      <p class="dim small">Ключ комнаты и ключи ящиков — в части ссылки после #. Она не уходит на сервер. Ссылку держите между собой.</p>
      <div class="linkbox">${esc(link)}</div>
      <div class="btns"><button class="btn" id="cp">[ КОПИРОВАТЬ ]</button>${navigator.share ? '<button class="btn" id="sh">[ ПОДЕЛИТЬСЯ ]</button>' : ''}</div>`;
    $('#cp').onclick = () => copy(link);
    if ($('#sh')) $('#sh').onclick = () => navigator.share({ title: 'P2P-MESH', text: 'Заходи в комнату', url: link }).catch(() => {});
  }

  function sheetCatalog() {
    $('#sheet-title').textContent = 'КАТАЛОГ КАНАЛОВ';
    $('#sheet-body').innerHTML = GROUPS.map((g) => {
      const items = CATALOG.filter((d) => d.group === g.id);
      return `<h3>▓ ${esc(g.title.toUpperCase())} <span class="dim">· ${esc(g.note)}</span></h3>` +
        items
          .map((d) => {
            const c = mesh.byId[d.id];
            let right = '';
            if (d.soon) right = `<span class="badge ${d.group === 'fun' ? 'fun' : ''}">${d.group === 'fun' ? 'МЕМ · СКОРО' : 'СКОРО'}</span>`;
            else if (c) right = `<button class="chip ${c.enabled ? 'on' : ''}" data-tog="${d.id}">${c.enabled ? 'ВКЛ' : 'ВЫКЛ'}</button>`;
            else right = `<button class="chip" data-conn="${d.id}">ПОДКЛЮЧИТЬ</button>`;
            const state = c ? (c.ready() ? 'на связи' : c.err || c.state) : '';
            const form = d.fields
              ? `<div class="form" id="f-${d.id}" hidden><p class="dim small">${esc(d.help)}</p>${d.fields
                  .map(([k, label, ph]) => `<label class="field"><span>${esc(label)}</span><input data-k="${k}" placeholder="${esc(ph)}" value="${esc(keys[d.id]?.[k] || '')}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`)
                  .join('')}<div class="btns"><button class="btn" data-save="${d.id}">[ СОХРАНИТЬ ]</button>${keys[d.id] ? `<button class="btn" data-del="${d.id}">[ УБРАТЬ ]</button>` : ''}</div></div>`
              : '';
            return `<div class="cat ${d.soon ? 'soon' : ''}"><div class="cat-h"><div><b>${esc(d.name)}</b> <span class="dim small">${esc(d.host || '')}</span></div>${right}</div>${d.about || state ? `<div class="dim small">${esc(d.about || '')}${state ? ` <span class="amb">[${esc(state)}]</span>` : ''}</div>` : ''}${c && d.fields ? `<button class="link small" data-conn="${d.id}">изменить ключи</button>` : ''}${form}</div>`;
          })
          .join('');
    }).join('');
    const body = $('#sheet-body');
    body.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tog) {
        const c = mesh.byId[b.dataset.tog];
        mesh.setEnabled(c.id, !c.enabled, ui.both);
        sheetCatalog();
      } else if (b.dataset.conn) {
        const f = $('#f-' + b.dataset.conn);
        f.hidden = !f.hidden;
      } else if (b.dataset.save) {
        const id = b.dataset.save;
        const v = {};
        $('#f-' + id).querySelectorAll('input').forEach((i) => (v[i.dataset.k] = i.value.trim()));
        if (Object.values(v).some((x) => !x)) return toast('ЗАПОЛНИТЕ ВСЕ ПОЛЯ');
        keys = { ...keys, [id]: v };
        store.set('keys', keys);
        history.replaceState(null, '', inviteLink(room, key).replace(location.origin + location.pathname, ''));
        location.reload();
      } else if (b.dataset.del) {
        delete keys[b.dataset.del];
        store.set('keys', keys);
        history.replaceState(null, '', `#r=${room}&k=${b64url(key)}`);
        location.reload();
      }
    };
  }

  function resultsText() {
    const h = mesh.history;
    const lines = [`P2P-MESH · комната ${room} · ${nick} · ${new Date().toLocaleString('ru')}`, `сообщений: ${h.length}`];
    const b5 = h.map((m) => m.best5).filter((v) => v != null);
    const t3 = h.map((m) => m.t3).filter((v) => v != null);
    lines.push(`3/5 лучших: медиана ${ms(median(b5))} мс · p95 ${ms(pct(b5, 0.95))} мс`);
    lines.push(`3/n все:    медиана ${ms(median(t3))} мс · p95 ${ms(pct(t3, 0.95))} мс`, '');
    lines.push('КАНАЛ               СТАТУС  МЕД    P95    ПОТЕРИ  ЗАМЕРОВ');
    const sorted = [...mesh.channels].sort((a, b) => (median(a.rtts) ?? 1e9) - (median(b.rtts) ?? 1e9));
    for (const c of sorted) {
      const st = !c.enabled ? 'выкл' : c.ready() ? 'ok' : 'нет';
      const loss = c.sent ? Math.round((c.lost / c.sent) * 100) + '%' : '--';
      lines.push(`${c.name.padEnd(19)} ${st.padEnd(7)} ${ms(median(c.rtts)).padEnd(6)} ${ms(pct(c.rtts, 0.95)).padEnd(6)} ${loss.padEnd(7)} ${c.rtts.length}${c.err ? '  ' + c.err : ''}`);
    }
    lines.push('', 'Время туда-обратно (RTT), мс. 3/5 лучших = третья доля среди 5 каналов с лучшей медианой.');
    return lines.join('\n');
  }
  function sheetResults() {
    $('#sheet-title').textContent = 'ИТОГИ ЗАМЕРА';
    const txt = resultsText();
    const pre = $('#sheet-body pre');
    if (pre) return void (pre.textContent = txt);
    $('#sheet-body').innerHTML = `<pre class="results"></pre><div class="btns"><button class="btn" id="cpr">[ СКОПИРОВАТЬ ИТОГИ ]</button></div>`;
    $('#sheet-body pre').textContent = txt;
    $('#cpr').onclick = () => copy(resultsText());
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
