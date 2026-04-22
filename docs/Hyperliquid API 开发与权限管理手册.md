# Hyperliquid API 开发与权限管理手册

Hyperliquid 交易所基于 L1 链构建，其 API 交互核心在于 **EIP-712 签名**。为了平衡安全与自动化需求，官方提供了两种主要的 API 接入方式。

## 1. 核心逻辑：签名权与账户权的解耦

这是 Hyperliquid API 设计的精髓，理解这一点能解决 90% 的集成困惑：

- **签名私钥 (Secret Key)**：回答了“**你是谁？**”的问题。它证明了请求是由被授权的实体（如 Agent）发出的。
    
- **账户地址 (Account Address)**：回答了“**动谁的钱？**”的问题。它定义了交易发生的环境（主账户、子账户或金库）。
    

**形象比喻：**

Agent 是你雇佣的**交易员**，他手里拿着你给的**授权书（Agent Private Key）**。当他去交易所下单时，他必须告诉柜台：“我是代表**老板（Master Address）**来交易的，请从老板的账户里扣除保证金”。

## 2. 方式一：主私钥直接签名 (Main Wallet Signing)

### 1.1 核心逻辑

直接在代码中加载你的以太坊钱包私钥（EOA），对每一笔指令进行签名。此时，“你是谁”和“动谁的钱”是同一个地址。

### 1.2 优缺点分析

- **优点**：全权限，逻辑简单。
    
- **缺点**：风险极高，私钥泄露即资金归零。
    

## 3. 方式二：代理地址签名 (API Agent) —— **推荐方式**

### 2.1 核心逻辑

主钱包生成并授权一个“影子地址”（Agent），并将交易权限委派给它。Agent 拥有签名权，但主钱包保留资产所有权。

### 2.2 获取 Agent 的两种途径 (生成教程)

你可以根据你的开发阶段选择以下任意一种方式来获取并授权 Agent：

#### 途径 A：通过网页端 (UI) 快速生成

适用于：手动管理、快速测试或对代码生成不熟悉的场景。

1. **访问页面**：登录 Hyperliquid，点击“更多 (More)” -> “API”。
    
2. **生成钱包**：输入一个你易于识别的名称，点击“**生成 (Generate)**”。
    
3. **保存私钥**：**重要！** 此时页面会显示一次私钥，请立即复制并存入安全的地方。
    
4. **进行授权**：点击“**授权 API 钱包 (Authorize API Wallet)**”，在 MetaMask 中签名确认。完成后，该地址正式生效。
    

#### 途径 B：通过脚本 (Code) 自动化生成

适用于：量化机器人部署、多账户批量管理。

1. **环境准备**：安装 `pip install hyperliquid-python-sdk`。
    
2. **运行脚本**：编写并运行一个一次性脚本（详见 4.1 节），使用 `eth_account.Account.create()` 在本地随机生成私钥。
    
3. **链上委派**：通过脚本调用 `exchange.approve_agent()` 完成主钱包对该新私钥地址的授权。
    

### 2.3 工业级开发架构建议

```
hl_trading_bot/
├── .env                # 存储 AGENT_KEY (严禁存储主私钥！)
├── setup_agent.py      # 授权脚本：主钱包运行一次，之后即可离线
└── main.py             # 交易机器人：仅加载 Agent 私钥和主地址
```

## 4. 代码实现参考

### 4.1 步骤 A：授权 Agent (一次性脚本)

```
import eth_account
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants

# 1. 临时加载主钱包私钥（仅用于本次授权）
MAIN_PRIVATE_KEY = "你的主钱包私钥"

# 2. 在本地生成一个随机的 Agent 账号
agent_account = eth_account.Account.create()
print(f"--- 授权成功后请保存以下信息 ---")
print(f"Agent 地址: {agent_account.address}")
print(f"Agent 私钥 (存入 .env): {agent_account.key.hex()}")

# 3. 使用主钱包去“介绍”这个 Agent 给交易所
main_account = eth_account.Account.from_key(MAIN_PRIVATE_KEY)
exchange = Exchange(main_account, constants.MAINNET_API_URL)

# 核心操作：将交易权限委派给 agent_account.address
result = exchange.approve_agent(agent_account.address)
print(f"授权状态: {result}")
```

### 4.2 步骤 B：使用 Agent 交易 (生产环境)

**注意：此步骤必须同时显式提供 Agent 私钥和主钱包地址。**

```
import eth_account
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants

# 从环境变量或 .env 加载
AGENT_KEY = "你的 Agent 私钥" 
MAIN_ADDRESS = "你的主钱包地址" 

agent_account = eth_account.Account.from_key(AGENT_KEY)

# 初始化时：
# 1. 第一个参数传入 agent_account，用于提供“签名”
# 2. account_address 传入主地址，用于提供“账户上下文”
exchange = Exchange(
    agent_account, 
    constants.MAINNET_API_URL, 
    account_address=MAIN_ADDRESS 
)

# 此时执行的操作将作用于 MAIN_ADDRESS 的资金池
print(f"正在代表 {MAIN_ADDRESS} 执行交易...")
order_result = exchange.market_open("ETH", True, 0.01, None, 0.01)
```

## 5. 网页端 (UI) 与代码的逻辑映射

|   |   |
|---|---|
|**网页操作**|**对应代码逻辑**|
|**“生成 (Generate)”按钮**|`eth_account.Account.create()`|
|**“授权 (Authorize)”按钮**|`exchange.approve_agent(agent_address)`|
|**API 钱包地址**|`agent_account.address`|
|**移除 (Remove)**|`exchange.revoke_agent(agent_address)`|

## 6. 常见问题 (FAQ)

**问：为什么我的 Agent 地址查不到余额？**

答：Agent 只是个“签名工具人”。所有的钱都在 `account_address` 指向的账户里。

**问：如果我忘了在代码里填 `account_address` 会怎样？**

答：交易所会尝试在 Agent 地址自己名下下单。由于 Agent 账户里没钱，你会收到 `Insufficient margin` 错误。

**问：Agent 模式下可以提币吗？**

答：不能。提币指令必须由主私钥亲自签名。

## 7. 安全开发 Checklist

1. **权限最小化**：生产服务器仅配置 Agent 私钥。
    
2. **物理隔离**：主钱包私钥（老板）和 Agent 私钥（员工）绝不能存在同一个地方。
    
3. **定期撤销**：怀疑 Agent 泄露时，立即在网页端点击“移除”或用脚本调用 `revoke`。
    

## 8. 常用参数参考

- **Mainnet API**: `https://api.hyperliquid.xyz`
    
- **SDK**: `pip install hyperliquid-python-sdk`