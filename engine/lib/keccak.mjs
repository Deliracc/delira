// Keccak-256 (the Ethereum hash, not NIST SHA3-256). Plain BigInt-free implementation on 32-bit halves.
const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000], [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000], [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const PI = [0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4];

function rotl(lo, hi, n) {
  if (n === 0) return [lo, hi];
  if (n >= 32) { [lo, hi] = [hi, lo]; n -= 32; }
  if (n === 0) return [lo, hi];
  return [((lo << n) | (hi >>> (32 - n))) >>> 0, ((hi << n) | (lo >>> (32 - n))) >>> 0];
}

function f(sl, sh) {
  const bl = new Array(25), bh = new Array(25), cl = new Array(5), ch = new Array(5);
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) { cl[x] = sl[x] ^ sl[x + 5] ^ sl[x + 10] ^ sl[x + 15] ^ sl[x + 20]; ch[x] = sh[x] ^ sh[x + 5] ^ sh[x + 10] ^ sh[x + 15] ^ sh[x + 20]; }
    for (let x = 0; x < 5; x++) {
      const [rl, rh] = rotl(cl[(x + 1) % 5], ch[(x + 1) % 5], 1);
      const dl = cl[(x + 4) % 5] ^ rl, dh = ch[(x + 4) % 5] ^ rh;
      for (let y = 0; y < 25; y += 5) { sl[x + y] = (sl[x + y] ^ dl) >>> 0; sh[x + y] = (sh[x + y] ^ dh) >>> 0; }
    }
    for (let i = 0; i < 25; i++) { const [l, h] = rotl(sl[i], sh[i], ROT[i]); bl[PI[i]] = l; bh[PI[i]] = h; }
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) {
      sl[x + y] = (bl[x + y] ^ (~bl[(x + 1) % 5 + y] & bl[(x + 2) % 5 + y])) >>> 0;
      sh[x + y] = (bh[x + y] ^ (~bh[(x + 1) % 5 + y] & bh[(x + 2) % 5 + y])) >>> 0;
    }
    sl[0] = (sl[0] ^ RC[r][0]) >>> 0; sh[0] = (sh[0] ^ RC[r][1]) >>> 0;
  }
}

export function keccak256(input) {
  const data = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const rate = 136, padded = Buffer.alloc(Math.floor(data.length / rate) * rate + rate);
  data.copy(padded); padded[data.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const sl = new Array(25).fill(0), sh = new Array(25).fill(0);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) { sl[i] = (sl[i] ^ padded.readUInt32LE(off + i * 8)) >>> 0; sh[i] = (sh[i] ^ padded.readUInt32LE(off + i * 8 + 4)) >>> 0; }
    f(sl, sh);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) { out.writeUInt32LE(sl[i], i * 8); out.writeUInt32LE(sh[i], i * 8 + 4); }
  return out;
}
