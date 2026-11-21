// Minimal EVM signing for the agent wallet: RLP, EIP-1559 (type 2) and legacy EIP-155 transactions, keys and addresses.
// No dependencies besides the vendored noble secp256k1 and our keccak. Checked against the EIP-155 spec vector in the tests.
import crypto from 'node:crypto';
import { keccak256 } from './keccak.mjs';
import { getPublicKey, signAsync } from './secp256k1.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// integers → minimal big-endian bytes (0 → empty); hex strings "0x…" → bytes; Buffers pass through
function bytes(x) {
  if (Buffer.isBuffer(x) || x instanceof Uint8Array) return Buffer.from(x);
  if (typeof x === 'string') { const h = x.replace(/^0x/, ''); return Buffer.from(h.length % 2 ? '0' + h : h, 'hex'); }
  let n = BigInt(x); if (n < 0n) throw new Error('negative');
  if (n === 0n) return Buffer.alloc(0);
  const h = n.toString(16); return Buffer.from(h.length % 2 ? '0' + h : h, 'hex');
}
function lenPrefix(len, short) {
  if (len < 56) return Buffer.from([short + len]);
  const l = bytes(len); return Buffer.concat([Buffer.from([short + 55 + l.length]), l]);
}
export function rlp(item) {
  if (Array.isArray(item)) { const body = Buffer.concat(item.map(rlp)); return Buffer.concat([lenPrefix(body.length, 0xc0), body]); }
  const b = bytes(item);
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([lenPrefix(b.length, 0x80), b]);
}

export function newKey() {
  for (;;) { const k = crypto.randomBytes(32); const n = BigInt('0x' + k.toString('hex')); if (n > 0n && n < N) return k; }
}
export function addressOf(priv) {
  const pub = Buffer.from(getPublicKey(Uint8Array.from(priv), false));
  return '0x' + keccak256(pub.subarray(1)).subarray(12).toString('hex');
}
export function checksum(a) {
  const x = String(a).toLowerCase().replace(/^0x/, ''), h = keccak256(x).toString('hex');
  return '0x' + [...x].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

async function sig(hash, priv) {
  const s = await signAsync(Uint8Array.from(hash), Uint8Array.from(priv));
  return { r: s.r, s: s.s, v: s.recovery };
}

// tx: { type: 2 | 0, chainId, nonce, gas, to, value, data, maxFeePerGas, maxPriorityFeePerGas } or { type: 0, gasPrice, … }
export async function signTx(tx, priv) {
  const to = tx.to ? bytes(tx.to) : Buffer.alloc(0), data = bytes(tx.data || '0x');
  if (tx.type === 2) {
    const fields = [tx.chainId, tx.nonce, tx.maxPriorityFeePerGas, tx.maxFeePerGas, tx.gas, to, tx.value || 0, data, []];
    const hash = keccak256(Buffer.concat([Buffer.from([2]), rlp(fields)]));
    const s = await sig(hash, priv);
    const raw = Buffer.concat([Buffer.from([2]), rlp([...fields, s.v, s.r, s.s])]);
    return { raw: '0x' + raw.toString('hex'), hash: '0x' + keccak256(raw).toString('hex') };
  }
  const base = [tx.nonce, tx.gasPrice, tx.gas, to, tx.value || 0, data];
  const hash = keccak256(rlp([...base, tx.chainId, 0, 0]));
  const s = await sig(hash, priv);
  const raw = rlp([...base, BigInt(s.v) + BigInt(tx.chainId) * 2n + 35n, s.r, s.s]);
  return { raw: '0x' + raw.toString('hex'), hash: '0x' + keccak256(raw).toString('hex') };
}

// ERC-20 calldata
const word = (x) => BigInt(x).toString(16).padStart(64, '0');
const addrWord = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const erc20 = {
  transfer: (to, units) => '0xa9059cbb' + addrWord(to) + word(units),
  approve: (spender, units) => '0x095ea7b3' + addrWord(spender) + word(units),
  balanceOf: (a) => '0x70a08231' + addrWord(a),
};
// decode the calldata DELIRA understands; anything else returns null (PLAIN cannot say it in plain words)
export function decodeCall(data) {
  const d = String(data || '0x').toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(d)) return null;
  const sel = d.slice(0, 10), args = d.slice(10);
  if (d === '0x' || d === '') return { method: 'none' };
  if (args.length !== 128) return { method: 'unknown', selector: sel };
  const a = '0x' + args.slice(24, 64), n = BigInt('0x' + args.slice(64, 128));
  if (args.slice(0, 24) !== '0'.repeat(24)) return { method: 'unknown', selector: sel };   // not a clean address argument
  if (sel === '0xa9059cbb') return { method: 'transfer', to: a, units: n };
  if (sel === '0x095ea7b3') return { method: 'approve', spender: a, units: n };
  if (sel === '0x39509351') return { method: 'increaseAllowance', spender: a, units: n };
  return { method: 'unknown', selector: sel };
}
