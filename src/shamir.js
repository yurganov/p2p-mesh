// Схема Шамира над GF(256): порог k, n долей, побайтно.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    let t = x << 1;
    if (t & 0x100) t ^= 0x11b;
    x = (x ^ t) & 0xff; // умножение на генератор 3
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);

export function split(secret, n, k = 3) {
  if (n < k || n > 255) throw new Error(`нужно ${k}..255 долей, есть ${n}`);
  const len = secret.length;
  const coef = crypto.getRandomValues(new Uint8Array(len * (k - 1)));
  const shares = [];
  for (let x = 1; x <= n; x++) {
    const y = new Uint8Array(len);
    for (let b = 0; b < len; b++) {
      let acc = secret[b];
      let xp = 1;
      for (let j = 0; j < k - 1; j++) {
        xp = mul(xp, x);
        acc ^= mul(coef[b * (k - 1) + j], xp);
      }
      y[b] = acc;
    }
    shares.push({ x, y });
  }
  return shares;
}

export function combine(points) {
  const len = points[0].y.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < points.length; i++) {
    let li = 1;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      li = mul(li, div(points[j].x, points[i].x ^ points[j].x));
    }
    const y = points[i].y;
    for (let b = 0; b < len; b++) out[b] ^= mul(y[b], li);
  }
  return out;
}
