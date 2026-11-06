// Каталог каналов и драйверы. Каждый драйвер передаёт строки (JSON-кадры) в общую «комнату».
import * as mqttNs from 'mqtt/dist/mqtt.esm';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256, bytesToHex, hexToBytes, utf8ToBytes, rand, randHex } from './util.js';

const mqttConnect = mqttNs.connect || mqttNs.default?.connect;

export class Channel {
  constructor(def) {
    Object.assign(this, { hiEvery: 4000, minGap: 0, fields: null }, def);
    this.state = 'off'; // off | connecting | up | down
    this.err = '';
    this.enabled = true;
    this.rtts = [];
    this.bw = []; // [байт доли, время в одну сторону]
    this.sent = 0;
    this.acked = 0;
    this.lost = 0;
    this.lastPeer = 0;
    this.lastShare = 0;
    this.lastHi = 0;
    this.last = null;
  }
  set(state, err = '') {
    this.state = state;
    this.err = err;
    this.ctx?.changed();
  }
  start(ctx) {
    this.ctx = ctx;
    this.set('connecting');
    try {
      this.open();
    } catch (e) {
      this.set('down', String(e.message || e));
    }
  }
  stop() {}
  recv(str) {
    this.ctx.frame(this, str);
  }
  ready() {
    return this.state === 'up';
  }
}

// ---------- WebRTC напрямую (STUN), signaling идёт через остальные каналы ----------
const ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.nextcloud.com:443' },
];

export class WebRTCChannel extends Channel {
  open() {
    this.set('connecting', 'жду друга для обмена параметрами');
  }
  async connect(peer) {
    this.reset();
    this.peer = peer;
    const pc = this.mk();
    this.bind(pc.createDataChannel('mesh', { ordered: false }));
    await pc.setLocalDescription(await pc.createOffer());
    await this.gathered(pc);
    this.ctx.signal(peer, { kind: 'offer', sdp: pc.localDescription.sdp, sid: this.sid });
  }
  async signal(from, m) {
    try {
      if (m.kind === 'offer') {
        this.reset();
        this.peer = from;
        this.sid = m.sid;
        const pc = this.mk();
        pc.ondatachannel = (e) => this.bind(e.channel);
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await this.gathered(pc);
        this.ctx.signal(from, { kind: 'answer', sdp: pc.localDescription.sdp, sid: m.sid });
      } else if (m.kind === 'answer' && this.pc && m.sid === this.sid && this.pc.signalingState === 'have-local-offer') {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      }
    } catch (e) {
      this.set('down', 'ошибка WebRTC: ' + (e.message || e));
    }
  }
  mk() {
    this.sid = this.sid || randHex(4);
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.pc = pc;
    this.set('connecting', 'устанавливаю прямое соединение');
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      const s = pc.connectionState;
      if (s === 'failed') this.set('down', 'прямое соединение не установилось (NAT)');
      if (s === 'disconnected' || s === 'closed') this.set('down', 'соединение разорвано');
    };
    return pc;
  }
  bind(dc) {
    this.dc = dc;
    dc.onopen = () => {
      this.set('up');
      this.route();
    };
    dc.onclose = () => this.set('down', 'канал закрыт');
    dc.onmessage = (e) => this.recv(e.data);
  }
  // какой путь выбрал ICE: IPv4 или IPv6, напрямую (host), через NAT (srflx) или через релей
  async route() {
    try {
      const st = await this.pc.getStats();
      let pair;
      st.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId);
      });
      if (!pair) st.forEach((r) => r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected) && (pair = r));
      if (!pair) return;
      const l = st.get(pair.localCandidateId), r = st.get(pair.remoteCandidateId);
      const ip = (l?.address || l?.ip || '').includes(':') ? 'IPv6' : 'IPv4';
      this.err = `${ip} · ${l?.candidateType} ↔ ${r?.candidateType} · ${l?.protocol || ''}`;
      this.ctx.changed();
    } catch {}
  }
  gathered(pc) {
    return new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 2500);
      pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && (clearTimeout(t), res());
    });
  }
  reset() {
    try {
      this.dc?.close();
      this.pc?.close();
    } catch {}
    this.dc = this.pc = null;
    this.sid = null;
  }
  send(s) {
    if (this.dc?.readyState === 'open') this.dc.send(s);
  }
  ready() {
    return this.dc?.readyState === 'open';
  }
}

// ---------- Nostr: эфемерные события kind 23333 с тегом комнаты ----------
const NOSTR_KIND = 23333;
let nostrKey;
function nostrIdentity() {
  if (!nostrKey) {
    const sk = rand(32);
    nostrKey = { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) };
  }
  return nostrKey;
}

export class NostrChannel extends Channel {
  open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    const sub = 's' + randHex(4);
    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', sub, { kinds: [NOSTR_KIND], '#t': [this.ctx.topic], since: Math.floor(Date.now() / 1000) - 5 }]));
      this.set('up');
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m[0] === 'EVENT' && m[2]?.content) this.recv(m[2].content);
      else if (m[0] === 'OK' && m[2] === false) this.err = 'релей отклонил: ' + m[3];
      else if (m[0] === 'NOTICE' || m[0] === 'CLOSED') this.err = String(m[m.length - 1]).slice(0, 80);
    };
    ws.onerror = () => this.set('down', 'ошибка соединения');
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.set('down', this.err || 'соединение закрыто');
      this.retry = setTimeout(() => this.start(this.ctx), 4000);
    };
  }
  send(content) {
    if (this.ws?.readyState !== 1) return;
    const { sk, pk } = nostrIdentity();
    const ev = { pubkey: pk, created_at: Math.floor(Date.now() / 1000), kind: NOSTR_KIND, tags: [['t', this.ctx.topic]], content };
    const id = sha256(utf8ToBytes(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])));
    ev.id = bytesToHex(id);
    ev.sig = bytesToHex(schnorr.sign(id, sk));
    this.ws.send(JSON.stringify(['EVENT', ev]));
  }
  ready() {
    return this.ws?.readyState === 1;
  }
}

// ---------- MQTT через WebSocket, публичные брокеры ----------
export class MqttChannel extends Channel {
  open() {
    const c = mqttConnect(this.url, {
      clientId: 'p2pm_' + randHex(6),
      clean: true,
      reconnectPeriod: 4000,
      connectTimeout: 8000,
      keepalive: 30,
    });
    this.c = c;
    this.t = 'p2pmesh/' + this.ctx.topic;
    c.on('connect', () => c.subscribe(this.t, { qos: 0 }, (e) => (e ? this.set('down', 'подписка: ' + e.message) : this.set('up'))));
    c.on('message', (_t, buf) => this.recv(new TextDecoder().decode(buf)));
    c.on('error', (e) => this.set('down', e.message));
    c.on('offline', () => this.set('down', 'нет связи с брокером'));
    c.on('reconnect', () => this.set('connecting'));
  }
  send(s) {
    if (this.c?.connected) this.c.publish(this.t, s, { qos: 0 });
  }
  ready() {
    return !!this.c?.connected;
  }
}

// ---------- ntfy.sh: POST + WebSocket-подписка ----------
export class NtfyChannel extends Channel {
  open() {
    const topic = 'p2pmesh_' + this.ctx.topic;
    this.pub = `${this.url}/${topic}`;
    const ws = new WebSocket(`${this.url.replace(/^http/, 'ws')}/${topic}/ws`);
    this.ws = ws;
    ws.onopen = () => this.set('up');
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.event === 'message' && m.message) this.recv(m.message);
      } catch {}
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.set('down', 'соединение закрыто');
      setTimeout(() => this.start(this.ctx), 5000);
    };
  }
  send(s) {
    fetch(this.pub, { method: 'POST', body: s }).then((r) => {
      if (r.status === 429) this.err = 'лимит ntfy (429)';
    }, () => (this.err = 'POST не прошёл'));
  }
  ready() {
    return this.ws?.readyState === 1;
  }
}

// ---------- Абонентские ящики (нужен ключ) ----------
export class SupabaseChannel extends Channel {
  open() {
    const { url, key } = this.cfg;
    const ws = new WebSocket(`${url.replace(/^http/, 'ws').replace(/\/$/, '')}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`);
    this.ws = ws;
    this.topicName = 'realtime:p2pmesh_' + this.ctx.topic;
    let ref = 1;
    this.ref = () => String(++ref);
    ws.onopen = () => {
      ws.send(JSON.stringify({ topic: this.topicName, event: 'phx_join', payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false }, access_token: key }, ref: '1', join_ref: '1' }));
      this.hb = setInterval(() => ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: this.ref() })), 25000);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.event === 'phx_reply' && m.ref === '1') m.payload?.status === 'ok' ? this.set('up') : this.set('down', JSON.stringify(m.payload?.response || '').slice(0, 80));
      if (m.event === 'broadcast' && m.payload?.payload?.d) this.recv(m.payload.payload.d);
    };
    ws.onclose = () => {
      clearInterval(this.hb);
      if (this.ws !== ws) return;
      this.set('down', 'соединение закрыто');
      setTimeout(() => this.start(this.ctx), 5000);
    };
  }
  send(s) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ topic: this.topicName, event: 'broadcast', payload: { type: 'broadcast', event: 'm', payload: { d: s } }, ref: this.ref(), join_ref: '1' }));
  }
}

export class AblyChannel extends Channel {
  open() {
    const ch = 'p2pmesh_' + this.ctx.topic;
    this.pub = `https://rest.ably.io/channels/${ch}/messages`;
    const es = new EventSource(`https://realtime.ably.io/sse?v=1.2&channels=${ch}&key=${encodeURIComponent(this.cfg.key)}`);
    this.es = es;
    es.onopen = () => this.set('up');
    es.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.data) this.recv(m.data);
      } catch {}
    };
    es.onerror = () => this.set(es.readyState === 2 ? 'down' : 'connecting', 'SSE переподключается');
  }
  send(s) {
    fetch(this.pub, { method: 'POST', headers: { Authorization: 'Basic ' + btoa(this.cfg.key), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'm', data: s }) }).catch(() => (this.err = 'POST не прошёл'));
  }
}

export class FirebaseChannel extends Channel {
  open() {
    const base = this.cfg.url.replace(/\/$/, '') + '/p2pmesh/' + this.ctx.topic;
    this.pub = base + '.json';
    const es = new EventSource(`${base}.json?orderBy=%22$key%22&limitToLast=1`);
    this.es = es;
    let first = true;
    es.onopen = () => this.set('up');
    es.addEventListener('put', (e) => {
      const m = JSON.parse(e.data);
      if (first) return void (first = false);
      if (m.path !== '/' && m.data?.d) this.recv(m.data.d);
    });
    es.addEventListener('cancel', () => this.set('down', 'нет доступа (правила базы)'));
    es.onerror = () => this.set(es.readyState === 2 ? 'down' : 'connecting', 'переподключение');
  }
  send(s) {
    fetch(this.pub, { method: 'POST', body: JSON.stringify({ d: s }) }).catch(() => (this.err = 'POST не прошёл'));
  }
}

export class UpstashChannel extends Channel {
  cmd(args) {
    return fetch(this.cfg.url.replace(/\/$/, ''), { method: 'POST', headers: { Authorization: 'Bearer ' + this.cfg.token }, body: JSON.stringify(args) }).then((r) => r.json());
  }
  open() {
    this.key = 'p2pmesh:' + this.ctx.topic;
    this.lastId = `${Date.now() - 3000}-0`;
    const poll = async () => {
      try {
        const r = await this.cmd(['XREAD', 'COUNT', '100', 'STREAMS', this.key, this.lastId]);
        if (r.error) throw new Error(r.error);
        if (this.state !== 'up') this.set('up');
        for (const [, entries] of r.result || []) {
          for (const [id, kv] of entries) {
            this.lastId = id;
            this.recv(kv[1]);
          }
        }
      } catch (e) {
        this.set('down', String(e.message || e).slice(0, 80));
      }
      this.timer = setTimeout(poll, 900);
    };
    poll();
  }
  send(s) {
    this.cmd(['XADD', this.key, 'MAXLEN', '~', '300', '*', 'd', s]).catch(() => (this.err = 'XADD не прошёл'));
  }
}

export class MatrixChannel extends Channel {
  api(path, opt = {}) {
    return fetch(this.cfg.hs.replace(/\/$/, '') + '/_matrix/client/v3' + path, { ...opt, headers: { Authorization: 'Bearer ' + this.cfg.token, 'Content-Type': 'application/json' } }).then((r) => r.json());
  }
  open() {
    const room = this.cfg.room;
    const filter = encodeURIComponent(JSON.stringify({ room: { rooms: [room], timeline: { limit: 1 }, state: { lazy_load_members: true } }, presence: { not_types: ['*'] }, account_data: { not_types: ['*'] } }));
    const loop = async (since) => {
      try {
        const r = await this.api(`/sync?filter=${filter}&timeout=${since ? 25000 : 0}${since ? '&since=' + since : ''}`);
        if (r.errcode) throw new Error(r.error);
        if (this.state !== 'up') this.set('up');
        if (since) for (const ev of r.rooms?.join?.[room]?.timeline?.events || []) if (ev.content?.body?.[0] === '{') this.recv(ev.content.body);
        loop(r.next_batch);
      } catch (e) {
        this.set('down', String(e.message || e).slice(0, 80));
        setTimeout(() => loop(since), 5000);
      }
    };
    loop(null);
  }
  send(s) {
    this.api(`/rooms/${encodeURIComponent(this.cfg.room)}/send/m.room.message/${randHex(8)}`, { method: 'PUT', body: JSON.stringify({ msgtype: 'm.text', body: s }) }).catch(() => (this.err = 'send не прошёл'));
  }
}

export class GitHubChannel extends Channel {
  gh(path, opt = {}) {
    return fetch('https://api.github.com/repos/' + this.cfg.repo + path, { ...opt, headers: { Authorization: 'Bearer ' + this.cfg.token, Accept: 'application/vnd.github+json' } });
  }
  open() {
    const seen = new Set();
    let since = new Date(Date.now() - 10000).toISOString();
    const poll = async () => {
      try {
        const r = await this.gh(`/issues/${this.cfg.issue}/comments?since=${since}&per_page=100`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (this.state !== 'up') this.set('up');
        for (const c of await r.json()) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          since = c.updated_at;
          if (c.body?.[0] === '{') this.recv(c.body);
        }
      } catch (e) {
        this.set('down', String(e.message || e));
      }
      this.timer = setTimeout(poll, 2500);
    };
    poll();
  }
  send(s) {
    this.gh(`/issues/${this.cfg.issue}/comments`, { method: 'POST', body: JSON.stringify({ body: s }) }).catch(() => (this.err = 'POST не прошёл'));
  }
}

// ---------- Каталог ----------
const nostr = (id, host, short) => ({ id, name: host, short, kind: NostrChannel, url: 'wss://' + host, group: 'nostr', host, about: `Публичный релей сети Nostr. Доля уходит подписанным эфемерным событием (kind 23333) с меткой комнаты; релей рассылает его подписчикам и не хранит. Регистрация не нужна, ключ подписи страница создаёт сама при каждом запуске.` });
const mq = (id, name, url) => ({ id, name, short: name, kind: MqttChannel, url, group: 'mqtt', host: new URL(url).host, about: `Публичный тестовый брокер MQTT ${name}. Подключение по WebSocket, доля публикуется в топик комнаты без хранения (QoS 0). Брокер открыт всем, поэтому имя топика — хеш ключа комнаты, а содержимое зашифровано.` });

export const GROUPS = [
  { id: 'direct', title: 'Прямой P2P', note: 'Без посредника и лимитов',
    plain: 'Телефоны говорят друг с другом напрямую, как две рации. Это самый быстрый путь. Но иногда мобильный оператор не даёт так соединиться, и тогда канал просто не включится.' },
  { id: 'nostr', title: 'Nostr-релеи', note: 'Без лимитов трафика',
    plain: 'Это как общие доски объявлений в интернете, которые держат добровольцы. Телефон вешает записку с долей сообщения, телефон друга сразу её видит. Доска общая, но прочитать записку нельзя: она зашифрована, а одна доля сама по себе ничего не значит.' },
  { id: 'mqtt', title: 'MQTT-брокеры', note: 'Без лимитов трафика',
    plain: 'Это как почтовое отделение для умных устройств вроде датчиков и лампочек. Один кладёт письмо в ячейку с номером, другой тут же его забирает. Номер ячейки знаете только вы двое.' },
  { id: 'ru', title: 'РФ-каналы', note: 'Для режима белых списков',
    plain: 'Российские сервисы. Они остаются доступны, даже когда в РФ включают «белые списки» и всё зарубежное перестаёт открываться.' },
  { id: 'soon', title: 'Скоро', note: 'Не подключены',
    plain: 'Способы, которые пока не подключены. У одних есть лимиты трафика или частоты, поэтому бесконечно гонять через них данные нельзя. Другим нужно настоящее приложение вместо сайта или отдельное железо.' },
  { id: 'fun', title: 'Шутливые', note: 'Мемные · скоро',
    plain: 'Шутка с долей правды: формально это тоже независимые каналы связи. Просто очень медленные.' },
];

export const CATALOG = [
  { id: 'webrtc', name: 'WebRTC напрямую', short: 'WebRTC', kind: WebRTCChannel, group: 'direct', host: 'STUN google/twilio', about: 'Прямое соединение двух браузеров по WebRTC DataChannel. Публичные STUN-серверы только помогают узнать внешний адрес, данные идут напрямую телефон ↔ телефон. Параметры соединения передаются через остальные каналы. Через мобильный CGNAT может не установиться: тогда нужен TURN-релей.' },
  nostr('n-noslol', 'nos.lol', 'nos.lol'),
  nostr('n-mom', 'nostr.mom', 'nostr.mom'),
  nostr('n-oxtr', 'nostr.oxtr.dev', 'oxtr'),
  nostr('n-primal', 'relay.primal.net', 'Primal'),
  nostr('n-wellorder', 'nostr-pub.wellorder.net', 'Wellorder'),
  nostr('n-snort', 'relay.snort.social', 'Snort'),
  nostr('n-nostrnet', 'relay.nostr.net', 'nostr.net'),
  mq('m-hivemq', 'HiveMQ', 'wss://broker.hivemq.com:8884/mqtt'),
  mq('m-emqx', 'EMQX', 'wss://broker.emqx.io:8084/mqtt'),
  mq('m-mosq', 'Mosquitto', 'wss://test.mosquitto.org:8081/mqtt'),
  mq('m-eclipse', 'Eclipse', 'wss://mqtt.eclipseprojects.io:443/mqtt'),
  { id: 'yandex', name: 'Yandex Object Storage', group: 'ru', soon: true, host: 'storage.yandexcloud.net', about: 'Ящик-файл на российском IP. Нужна проверка CORS.' },
  { id: 'yadisk', name: 'Яндекс Диск', group: 'ru', soon: true, host: 'cloud-api.yandex.net', about: 'Файлы на Диске как ящик, OAuth-токен.' },
  { id: 'vk', name: 'VK', group: 'ru', soon: true, host: 'api.vk.com', about: 'API не пускает запросы со сторонних страниц.' },
  ...[
    ['ntfy', 'ntfy.sh', 'Бесплатно около 250 сообщений в день, для бесконечного обмена не годится'],
    ['supabase', 'Supabase Realtime', 'Бесплатно около 2 млн сообщений в месяц'],
    ['ably', 'Ably', 'Бесплатно около 6 млн сообщений в месяц'],
    ['firebase', 'Firebase RTDB', 'Бесплатно около 10 ГБ трафика в месяц'],
    ['upstash', 'Upstash Redis', 'Лимит команд в месяц, опрос его быстро съедает'],
    ['matrix', 'Matrix', 'Сервер ограничивает частоту сообщений'],
    ['github', 'GitHub Issue', 'Жёсткие лимиты на частоту комментариев'],
    ['damus', 'relay.damus.io', 'Строгий лимит частоты, банит за частые события'],
    ['turn', 'WebRTC через TURN', 'Релей для WebRTC, нужен ключ Metered или Cloudflare'],
    ['telegram', 'Telegram-бот', 'Два бота и канал; в РФ ограничен'],
    ['email', 'Email', 'Из браузера напрямую SMTP не отправить'],
    ['ipfs', 'IPFS', 'Асинхронный ящик по CID'],
    ['tron', 'TRON memo', 'Блокчейн как почтовый ящик'],
    ['tor', 'Tor', 'В РФ только через мосты'],
    ['ble', 'Bluetooth LE', 'В Safari на iOS нет Web Bluetooth'],
    ['nfc', 'NFC', 'В Safari на iOS нет Web NFC'],
    ['audio', 'Акустический модем', 'Данные звуком через динамик и микрофон, когда телефоны рядом'],
    ['callmodem', 'Звонок + аудиомодем', 'Данные превращаются в звук и идут по обычному телефонному звонку, как у старых модемов. Работает даже без мобильного интернета, если есть голосовая связь. Голосовые кодеки и шумоподавление искажают сигнал, поэтому нужна коррекция ошибок. Сайт не может сам позвонить и слушать звонок: нужно приложение или внешний модем'],
    ['qr', 'QR-коды', 'Ручная передача камерой'],
    ['lora', 'LoRa / Meshtastic', 'Нужно внешнее радио'],
    ['findmy', 'Find My / Send My', 'Чужие iPhone как ретрансляторы, ~3 Б/с'],
  ].map(([id, name, about]) => ({ id, name, about, group: 'soon', soon: true })),
  ...[
    ['spotify', 'Spotify-плейлист', 'Трек в общем плейлисте как код сообщения. В РФ Spotify нет, это часть мема'],
    ['pigeon', 'Голуби RFC 1149', 'IP over Avian Carriers. Packet loss — это кошка'],
  ].map(([id, name, about]) => ({ id, name, about, group: 'fun', soon: true })),
];
