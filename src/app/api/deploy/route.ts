export const runtime = 'edge';

import { NextRequest, NextResponse } from 'next/server';
import { Wallet, keccak256, getBytes } from 'ethers';
import { encode as msgpackEncode } from '@msgpack/msgpack';

const MAX_BULK_ORDERS = 50;
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const HL_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';

// Fallback asset index (BTC is universally index 0 in HyperLiquid's universe)
const DEFAULT_ASSET_INDEX = 0;
const DEFAULT_SZ_DECIMALS = 3;

// EIP-712 constants (from HyperLiquid protocol)
const HL_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

const HL_AGENT_TYPES: Record<string, { name: string; type: string }[]> = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

type OrderWire = {
  a: number;   // asset index
  b: boolean;  // isBuy
  p: string;   // price string
  s: string;   // size string
  r: boolean;  // reduceOnly
  t: { limit: { tif: 'Gtc' } };
};

type DeployOrder = {
  coin: string;
  is_buy: boolean;
  sz: number;
  limit_px: number;
  order_type: { limit: { tif: 'Gtc' } };
  reduce_only: boolean;
};

function isDeployOrder(order: unknown): order is DeployOrder {
  if (!order || typeof order !== 'object') return false;
  const c = order as Partial<DeployOrder>;
  return (
    (c.coin === 'BTC-PERP' || c.coin === 'BTC') &&
    typeof c.is_buy === 'boolean' &&
    typeof c.sz === 'number' &&
    Number.isFinite(c.sz) &&
    c.sz >= 0.001 &&
    Math.round(c.sz * 1000) === c.sz * 1000 &&
    typeof c.limit_px === 'number' &&
    Number.isFinite(c.limit_px) &&
    c.limit_px > 0 &&
    Number.isInteger(c.limit_px) &&
    typeof c.reduce_only === 'boolean' &&
    c.order_type?.limit?.tif === 'Gtc'
  );
}

// Recursively remove trailing zeros from numeric strings in the action object.
// Matches SDK's normalizeTrailingZeros to ensure consistent msgpack encoding.
function normalizeAction(obj: unknown): unknown {
  if (typeof obj === 'string' && /^\d+\.\d+$/.test(obj)) {
    return obj.replace(/\.?0+$/, '');
  }
  if (Array.isArray(obj)) return obj.map(normalizeAction);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj as object)) {
      result[key] = normalizeAction((obj as Record<string, unknown>)[key]);
    }
    return result;
  }
  return obj;
}

// Build the bytes that are hashed to produce the EIP-712 connectionId.
// Layout: [msgpack(action) | nonce as 8-byte big-endian | 0x00 if no vault | 0x01+20-byte vault if present]
function hashAction(action: unknown, vaultAddress: string | null, nonce: number): string {
  const encoded = msgpackEncode(normalizeAction(action));
  const extraLen = vaultAddress === null ? 9 : 29;
  const combined = new Uint8Array(encoded.length + extraLen);
  combined.set(encoded);
  const view = new DataView(combined.buffer);
  view.setBigUint64(encoded.length, BigInt(nonce), false);
  if (vaultAddress === null) {
    view.setUint8(encoded.length + 8, 0);
  } else {
    view.setUint8(encoded.length + 8, 1);
    combined.set(getBytes(vaultAddress), encoded.length + 9);
  }
  return keccak256(combined);
}

async function signL1Action(
  wallet: Wallet,
  action: unknown,
  vaultAddress: string | null,
  nonce: number,
): Promise<{ r: string; s: string; v: number }> {
  const connectionId = hashAction(action, vaultAddress, nonce);
  const message = { source: 'a', connectionId };
  const sig = await wallet.signTypedData(HL_DOMAIN, HL_AGENT_TYPES, message);
  return {
    r: '0x' + sig.slice(2, 66),
    s: '0x' + sig.slice(66, 130),
    v: parseInt(sig.slice(130, 132), 16),
  };
}

async function getUserRole(address: string): Promise<string> {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userRole', user: address }),
  });
  if (!res.ok) return 'unknown';
  const data = await res.json();
  return data?.role || 'missing';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { privateKey, masterAddress, orders, assetIndex, szDecimals } = body;
    const resolvedAssetIndex = typeof assetIndex === 'number' ? assetIndex : DEFAULT_ASSET_INDEX;
    const resolvedSzDecimals = typeof szDecimals === 'number' ? szDecimals : DEFAULT_SZ_DECIMALS;

    if (typeof privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      return NextResponse.json({ status: 'err', msg: 'Missing private key' }, { status: 400 });
    }
    if (typeof masterAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(masterAddress)) {
      return NextResponse.json({ status: 'err', msg: 'Missing master address' }, { status: 400 });
    }
    if (!orders || !Array.isArray(orders) || orders.length === 0 || orders.length > MAX_BULK_ORDERS || !orders.every(isDeployOrder)) {
      return NextResponse.json({ status: 'err', msg: 'Invalid orders' }, { status: 400 });
    }

    const wallet = new Wallet(privateKey);
    const signerAddress = wallet.address;

    const [signerRole, masterRole] = await Promise.all([
      getUserRole(signerAddress),
      getUserRole(masterAddress),
    ]);

    if (masterRole !== 'user') {
      return NextResponse.json({
        status: 'err',
        msg: `Master 地址 ${masterAddress} 在 HyperLiquid 主网不是 user，当前 role=${masterRole}`,
      }, { status: 400 });
    }
    if (signerRole === 'missing') {
      return NextResponse.json({
        status: 'err',
        msg: `私钥地址 ${signerAddress} 还不是 HyperLiquid 用户或已批准 API Wallet。请用 ${masterAddress} 的主账号私钥部署，或先在 HyperLiquid 为 master 账号批准该 API Wallet。`,
      }, { status: 400 });
    }

    // Build wire-format orders
    const orderWires: OrderWire[] = (orders as DeployOrder[]).map(o => ({
      a: resolvedAssetIndex,
      b: o.is_buy,
      p: String(Math.round(o.limit_px)),
      s: o.sz.toFixed(resolvedSzDecimals).replace(/\.?0+$/, ''),
      r: o.reduce_only,
      t: o.order_type,
    }));

    const action = { type: 'order', orders: orderWires, grouping: 'na' };
    const nonce = Date.now();
    // Agent mode: sign with null vaultAddress. The on-chain agent authorization
    // already links this agent key to the master account; no vaultAddress in payload.
    const signature = await signL1Action(wallet, action, null, nonce);

    const payload = { action, nonce, signature };

    const res = await fetch(HL_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const response = await res.json();
    return NextResponse.json(response);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown server error';
    console.error('HyperLiquid deploy error:', err);
    return NextResponse.json({ status: 'err', msg }, { status: 500 });
  }
}
