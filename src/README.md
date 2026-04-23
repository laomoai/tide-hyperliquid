# Tide — HyperLiquid 网格交易终端

基于 Fibonacci 回撤的 BTC-PERP 网格交易终端，支持 HyperLiquid 全交易对，部署在 Cloudflare Pages。

**线上地址：[tide.lemoai.xyz](https://tide.lemoai.xyz)**

---

## 功能

- **K 线图表**：TradingView Lightweight Charts，支持多时间周期，实时 WebSocket 推送
- **Fibonacci 网格**：自动计算回撤位，生成买/卖挂单矩阵，支持手动调整数量
- **多交易对**：左上角下拉选择 HyperLiquid 全部永续合约，动态适配 lot size / asset index
- **一键部署**：批量下单（最多 50 张），EIP-712 签名，支持 API Wallet（Agent 模式）
- **现有订单**：查看账户全部挂单，按币种分组，显示触发单类型与触发条件，支持单个 / 批量 / 全部取消
- **参数持久化**：杠杆、资金量、界面缩放、当前交易对均自动保存至 localStorage
- **界面缩放**：侧边栏 70%–200% 缩放滑块，适配不同屏幕尺寸

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js 15 App Router（Edge Runtime） |
| 样式 | Tailwind CSS v4 |
| 图表 | TradingView Lightweight Charts |
| 签名 | ethers.js v6，EIP-712 |
| 序列化 | @msgpack/msgpack |
| 部署 | Cloudflare Pages（@cloudflare/next-on-pages） |

## 本地运行

```bash
cd src
npm install
npm run dev
```

访问 [http://localhost:3000](http://localhost:3000)

## 部署

```bash
cd src
npm run pages:deploy
```

需先登录 Cloudflare：`wrangler login`

## 使用说明

1. 在**参数与状态**标签填入：
   - Master 地址（HyperLiquid 主账号地址）
   - 私钥（主账号私钥，或已授权的 API Wallet 私钥）
   - 总资金量 & 杠杆倍数
2. 左上角下拉选择交易对
3. 在**部署订单**标签勾选要挂的价位，点击「部署网格」
4. 在**现有订单**标签查看和管理挂单

> 私钥仅在浏览器本地处理，通过自部署的 Edge Function 签名后发送至 HyperLiquid，不经过任何第三方服务器。
