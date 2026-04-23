export const runtime = 'edge';

import { NextRequest, NextResponse } from 'next/server';
import { Wallet, keccak256, getBytes } from 'ethers';
import { encode as msgpackEncode } from '@msgpack/msgpack';

const HL_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { privateKey, cancels } = body;

    if (typeof privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      return NextResponse.json({ status: 'err', msg: '缺少有效私钥' }, { status: 400 });
    }
    if (!Array.isArray(cancels) || cancels.length === 0 ||
        !cancels.every((c: unknown) => c !== null && typeof c === 'object' &&
          typeof (c as Record<string, unknown>).oid === 'number' &&
          typeof (c as Record<string, unknown>).assetIndex === 'number')) {
      return NextResponse.json({ status: 'err', msg: '无效取消列表' }, { status: 400 });
    }

    const wallet = new Wallet(privateKey);
    const action = {
      type: 'cancel',
      cancels: (cancels as { oid: number; assetIndex: number }[]).map(c => ({ a: c.assetIndex, o: c.oid })),
    };
    const nonce = Date.now();
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
    return NextResponse.json({ status: 'err', msg }, { status: 500 });
  }
}
