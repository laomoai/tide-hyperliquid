import { Hyperliquid } from 'hyperliquid';
import { ethers } from 'ethers';

async function test() {
  console.log("Hyperliquid Class keys:", Object.getOwnPropertyNames(Hyperliquid.prototype));
}
test();
