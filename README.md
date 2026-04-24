# Tide × HyperLiquid

BTC-PERP 斐波那契网格交易终端，基于 HyperLiquid 永续合约市场，自动计算多时间框架斐波那契共振区间，生成加权订单矩阵并一键部署限价单。

**在线地址：** [tide.lemoai.xyz](https://tide.lemoai.xyz)

---

## 核心功能

### 多时间框架斐波那契分析
- 分别计算 1D 和 4H K 线的历史高低点，生成各 7 条斐波那契回撤位（0 / 0.236 / 0.382 / 0.5 / 0.618 / 0.786 / 1）
- 两组斐波那契位叠加显示在 K 线图上（可分别开关）
- 高低点回溯深度可在设置页面配置（默认 89 根 K 线，支持改为 55 / 144 等）

### 订单矩阵生成
- 将距离相近的斐波那契位（默认容差 0.5%）聚合为一个价格簇
- 1D 斐波那契位权重为 2（两个时间框架共振），4H 单独位权重为 1
- 深度加权（Depth Scale）：离当前价格越远的订单，分配比例越高（马丁格尔效应）
- 星级 ★ 表示原始共振权重：★ = 仅 4H，★★ = 仅 1D，★★★ = 1D + 4H 双重共振
- 总仓位按权重比例分配到各簇，自动换算为 BTC 数量
- 数量可手动改写；价格悬停后点铅笔图标也可手动改写，改价后自动重判 Buy/Sell 并同步图表标线，一键「恢复默认」回到生成价

### 一键部署限价单
- 使用 HyperLiquid API Wallet（Agent 钱包）签名，私钥不离开本地
- 在浏览器端将私钥和 Master 地址发送到 `/api/deploy`（自建 Edge Function），由服务端完成 EIP-712 签名并提交到 HyperLiquid L1
- 支持批量下单（最多 50 单）、最小下单量校验（≥ 0.001 BTC）、价格整数校验（tick size = $1）

### 图表功能
- 数据源：HyperLiquid REST API（`candleSnapshot`），实时更新通过 WebSocket 推送
- 支持 5M / 15M / 30M / 1H / 2H / 4H / 1D 切换
- 可配置默认显示根数（50 ～ 2200 根），K 线右侧固定留白 30 根
- EMA20 均线（深色模式深灰 / 浅色模式浅灰）
- 网格背景线开关
- 亮色 / 暗色主题
- 当前交易对若持有仓位，图表以金黄色虚线标出入场价

### 全局持仓
- 侧边栏「参数」tab 列出 HyperLiquid 账户下全部永续持仓，非当前交易对也一并展示
- 每张卡片显示方向、数量、入场价、未实现盈亏；当前选中交易对的卡片带金色边框高亮

### 余额快照
- 侧边栏「余额」tab 记录账户总权益（含浮盈）的时间序列
- 每 24 小时自动追加一条，也可手动「立即快照」
- 表格显示 日期 / 余额 / 与上一条的 Δ%；支持按行删除或一键清空
- 数据存在本地 `localStorage`，不经过任何第三方服务

---

## 快速开始

### 前置条件
- Node.js 18+
- 一个 HyperLiquid 主网账号（已充值 USDC 到合约账户）
- 一个已授权的 API Wallet（Agent）私钥

> 如何获取 API Wallet：登录 HyperLiquid → More → API → Generate → Authorize API Wallet，保存显示的私钥。

### 本地运行

```bash
git clone <repo>
cd src
npm install
npm run dev
```

访问 `http://localhost:3000`，在右上角设置页面填写：
- **Master 地址**：你的主钱包地址（0x...）
- **Agent 私钥**：API Wallet 的私钥（0x...）

### 生产构建

```bash
npm run build
npm run start
```

---

## 部署到 Cloudflare Pages

项目已配置好 `@cloudflare/next-on-pages`，`/api/deploy` 作为 Edge Function 运行。

```bash
# 首次部署（需 wrangler 登录）
npm run pages:build
npx wrangler pages deploy .vercel/output/static --project-name tide

# 后续更新
npm run pages:deploy
```

`wrangler.toml` 中已启用 `nodejs_compat` 标志，`ethers` 和 `@msgpack/msgpack` 在 Cloudflare Edge 上可正常运行。

---

## 配置项（设置页面）

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 斐波那契回溯深度 | 计算高低点的 K 线根数 | 89 |
| 默认显示根数 | 图表初始可见 K 线数量 | 200 |
| Master 地址 | HyperLiquid 主钱包地址 | — |
| Agent 私钥 | API Wallet 私钥，仅用于签名 | — |
| 颜色自定义 | 买入/卖出斐波那契线和标签颜色 | — |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端框架 | Next.js 15 (App Router) + React 19 |
| 图表 | lightweight-charts v5 |
| 样式 | Tailwind CSS v4 |
| 签名 | ethers v6 + @msgpack/msgpack（EIP-712 Agent 模式） |
| 部署 | Cloudflare Pages + Edge Functions |

---

## 安全说明

- **私钥仅用于签名**：Agent 私钥没有提币权限，即使泄露也无法转移资产
- **主私钥不应填入本工具**：设置中填写的是 API Wallet（Agent）私钥，而非主钱包私钥
- 私钥通过 HTTPS 传输到自建 Edge Function，不经过任何第三方服务
- 若怀疑 Agent 泄露，在 HyperLiquid 网页端 More → API → Remove 立即撤销授权

---

## 订单矩阵选择

| 按钮 | 效果 |
|------|------|
| 全选 | 勾选所有订单 |
| 全不选 | 取消所有订单 |
| 买单 | 仅勾选当前价以下的买入单 |
| 卖单 | 仅勾选当前价以上的卖出单 |
| ★ | 仅勾选单时间框架 4H 位（较弱共振） |
| ★★ | 仅勾选单时间框架 1D 位（中等共振） |
| ★★★ | 仅勾选 1D + 4H 双重共振位（最强支撑/阻力） |
