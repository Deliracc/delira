// Networks and tokens the rails support, and a formatter for token amounts.
// Token contracts were checked on-chain (symbol and decimals).
export const COINS = {
  USDT: { name: 'Tether', stable: true },
  USDC: { name: 'USD Coin', stable: true },
  ETH: { name: 'Ether', stable: false },
  BNB: { name: 'BNB', stable: false },
};
// Contracts checked on-chain (symbol + decimals) on 2026-11-19.
export const NETWORKS = {
  ethereum: { name: 'Ethereum', std: 'ERC-20', chainId: 1, rpc: 'https://ethereum-rpc.publicnode.com', conf: 12, blockSec: 12,
    assets: { USDT: { token: '0xdac17f958d2ee523a2206206994597c13d831ec7', dec: 6 }, USDC: { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', dec: 6 }, ETH: { dec: 18 } } },
  bsc: { name: 'BNB Chain', std: 'BEP-20', chainId: 56, rpc: 'https://bsc-rpc.publicnode.com', conf: 15, blockSec: 0.5,
    assets: { USDT: { token: '0x55d398326f99059ff775485246999027b3197955', dec: 18 }, USDC: { token: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', dec: 18 }, BNB: { dec: 18 } } },
  polygon: { name: 'Polygon', std: 'Polygon PoS', chainId: 137, rpc: 'https://polygon-bor-rpc.publicnode.com', conf: 64, blockSec: 2,
    assets: { USDT: { token: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', dec: 6 }, USDC: { token: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', dec: 6 } } },
  arbitrum: { name: 'Arbitrum One', std: 'Arbitrum', chainId: 42161, rpc: 'https://arb1.arbitrum.io/rpc', conf: 20, blockSec: 0.25,
    assets: { USDT: { token: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', dec: 6 }, USDC: { token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', dec: 6 }, ETH: { dec: 18 } } },
  base: { name: 'Base', std: 'Base', chainId: 8453, rpc: 'https://base-rpc.publicnode.com', conf: 15, blockSec: 2,
    assets: { USDC: { token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', dec: 6 }, ETH: { dec: 18 } } },
};

const pow10 = (n) => 10n ** BigInt(n);
export function fmtUnits(units, dec, shown) {
  const u = BigInt(units), s = u.toString().padStart(dec + 1, '0');
  const whole = s.slice(0, -dec) || '0', frac = s.slice(-dec).slice(0, shown);
  return frac.replace(/0+$/, '') ? whole + '.' + frac.replace(/0+$/, '') : whole;
}
