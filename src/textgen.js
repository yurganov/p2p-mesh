// Случайный текст для автоотправки: набор слов или «абзацы» из случайных фраз.
const ADJ = 'лиловый тихий быстрый сонный ржавый весёлый древний бумажный ночной стальной хрупкий тёплый лунный кривой медный дальний седой упрямый прозрачный ламповый'.split(' ');
const NOUN = 'маяк кот модем голубь трамвай чайник радиоприёмник пакет кабель сервер облако фонарь пароход дракон кактус телетайп енот спутник почтальон вентилятор'.split(' ');
const VERB = 'считает слушает ловит шифрует отправляет ищет роняет чинит пересылает рисует охраняет будит качает переводит пеленгует'.split(' ');
const OBJ = 'облака у реки, старые биты, тишину эфира, долю Шамира, звёзды над крышей, пинги до утра, письма без адреса, сигнал из подвала, ключи от сейфа, пакеты по кругу'.split(', ');
const ADV = 'неторопливо внезапно аккуратно трижды по ночам вполголоса без устали на рассвете наугад шёпотом'.split(' ');
const TAIL = ['.', '.', '.', '!', '…', '?'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

function sentence() {
  const s = `${pick(ADJ)} ${pick(NOUN)} ${pick(ADV)} ${pick(VERB)} ${pick(OBJ)}`;
  return s[0].toUpperCase() + s.slice(1) + pick(TAIL);
}

export function randomText(mode, size) {
  let out = '';
  if (mode === 'words') {
    const all = [...ADJ, ...NOUN, ...VERB, ...ADV];
    while (out.length < size) out += (out ? ' ' : '') + pick(all);
  } else {
    while (out.length < size) {
      let p = '';
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n && out.length + p.length < size; i++) p += (p ? ' ' : '') + sentence();
      out += (out ? '\n\n' : '') + p;
    }
  }
  return out.slice(0, size);
}
