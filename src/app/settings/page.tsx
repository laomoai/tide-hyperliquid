'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { Eye, EyeOff, Save, CheckCircle2, AlertCircle, ChevronLeft } from 'lucide-react';

function getPerpAccountValue(data: any): string {
  return data?.marginSummary?.accountValue || '0.00';
}

export default function SettingsPage() {
  const readLocalStorage = (key: string, fallback: string) => {
    if (typeof window === 'undefined') return fallback;
    return localStorage.getItem(key) || fallback;
  };

  const [fibParam, setFibParam] = useState(() => readLocalStorage('fibParam', '89'));
  const [visibleCandles, setVisibleCandles] = useState(() => readLocalStorage('visibleCandles', '200'));
  const [colorBuy, setColorBuy] = useState(() => readLocalStorage('colorBuy', '#02C076'));
  const [colorBuyStrong, setColorBuyStrong] = useState(() => readLocalStorage('colorBuyStrong', '#00FF9D'));
  const [colorSell, setColorSell] = useState(() => readLocalStorage('colorSell', '#CF304A'));
  const [colorSellStrong, setColorSellStrong] = useState(() => readLocalStorage('colorSellStrong', '#FF4B6A'));
  const [colorLabelText, setColorLabelText] = useState(() => readLocalStorage('colorLabelText', '#FFFFFF'));
  const [lineWidthScalar, setLineWidthScalar] = useState(() => Number(readLocalStorage('lineWidthScalar', '1')));

  const [hlAddress, setHlAddress] = useState(() => readLocalStorage('hlAddress', ''));
  const [hlPrivateKey, setHlPrivateKey] = useState(() => readLocalStorage('hlPrivateKey', ''));
  const [showKey, setShowKey] = useState(false);
  
  const [testResult, setTestResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [errorMSG, setErrorMSG] = useState<string | null>(null);

  const handleSaveStandard = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('fibParam', fibParam);
      localStorage.setItem('visibleCandles', visibleCandles);
      localStorage.setItem('colorBuy', colorBuy);
      localStorage.setItem('colorBuyStrong', colorBuyStrong);
      localStorage.setItem('colorSell', colorSell);
      localStorage.setItem('colorSellStrong', colorSellStrong);
      localStorage.setItem('colorLabelText', colorLabelText);
      localStorage.setItem('lineWidthScalar', lineWidthScalar.toString());
      localStorage.setItem('hlAddress', hlAddress);
      localStorage.setItem('hlPrivateKey', hlPrivateKey);
      alert('设置已成功保存本地！');
    }
  };

  const handleTestConnection = async () => {
    if (!hlAddress) {
      setErrorMSG('钱包地址不得为空');
      return;
    }

    try {
      setTesting(true);
      setErrorMSG(null);
      setTestResult(null);

      const resState = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "clearinghouseState", user: hlAddress })
      });

      if (!resState.ok) {
        throw new Error("拉取账户结算状态失败");
      }
      const dataState = await resState.json();

      // fetch fills/trades
      const resFills = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "userFills", user: hlAddress })
      });
      if (!resFills.ok) {
         throw new Error("拉取交易历史失败");
      }
      const dataFills = await resFills.json();

      setTestResult({
        balance: getPerpAccountValue(dataState),
        positions: dataState.assetPositions || [],
        fills: dataFills.slice(0, 5)
      });

      // auto save on success
      if (typeof window !== 'undefined') {
        localStorage.setItem('hlAddress', hlAddress);
        localStorage.setItem('hlPrivateKey', hlPrivateKey);
      }
    } catch (err: any) {
      setErrorMSG(err.message || '连接失败，请检查网络或地址格式');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex-1 w-full h-full overflow-y-auto bg-bg-main text-text-main p-6 sm:p-10 font-sans">
      <div className="max-w-4xl mx-auto space-y-10">
        
        <div className="flex flex-col space-y-4">
          <Link href="/" className="inline-flex items-center text-sm text-text-muted hover:text-text-main w-fit px-2 py-1 -ml-2 rounded hover:bg-bg-card transition-colors">
            <ChevronLeft className="w-4 h-4 mr-1" />
            返回交易终端
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-2">系统设置</h1>
            <p className="text-text-muted">配置您的图表参数和交易所连接</p>
          </div>
        </div>

        <section className="bg-bg-card border border-border-subtle rounded-xl p-6">
          <h2 className="text-xl font-semibold mb-6 flex items-center">
            <span className="w-2 h-6 bg-fib-a rounded mr-3"></span>
            终端参数与视觉定制 (修改后需重新进入图表)
          </h2>
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-text-muted mb-2">
                斐波那契 参考周期基数 (日线/4H线)
              </label>
              <input 
                type="number"
                value={fibParam}
                onChange={(e) => setFibParam(e.target.value)}
                className="w-full sm:w-64 bg-bg-main border border-border-subtle text-text-main rounded-md px-4 py-2 focus:outline-none focus:border-fib-a font-mono"
                placeholder="89"
              />
              <p className="mt-2 text-xs text-text-muted">默认为 89。此参数将决定程序拉取并在图表中运算多少根大级别K线。</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-muted mb-2">
                图表默认展示 K 线根数
              </label>
              <input
                type="number"
                value={visibleCandles}
                onChange={(e) => setVisibleCandles(e.target.value)}
                className="w-full sm:w-64 bg-bg-main border border-border-subtle text-text-main rounded-md px-4 py-2 focus:outline-none focus:border-fib-a font-mono"
                placeholder="200"
                min="50"
                max="2200"
              />
              <p className="mt-2 text-xs text-text-muted">默认为 200。进入图表时初始视口展示的 K 线根数，范围 50–2200。修改后需重新进入图表生效。</p>
            </div>

            <div className="pt-4 border-t border-border-subtle">
              <label className="block text-sm font-medium text-text-muted mb-4">网格线条与颜色自定义 (包含挂单柱状图)</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                <div>
                   <p className="text-xs text-text-muted mb-1">做多/支撑线 (普通)</p>
                   <div className="flex items-center space-x-2">
                     <input type="color" value={colorBuy} onChange={e=>setColorBuy(e.target.value)} className="w-8 h-8 rounded shrink-0 cursor-pointer border border-border-subtle bg-transparent p-0 block" />
                     <span className="text-xs font-mono">{colorBuy.toUpperCase()}</span>
                   </div>
                </div>
                <div>
                   <p className="text-xs text-text-muted mb-1">做多/支撑线 (强共振)</p>
                   <div className="flex items-center space-x-2">
                     <input type="color" value={colorBuyStrong} onChange={e=>setColorBuyStrong(e.target.value)} className="w-8 h-8 rounded shrink-0 cursor-pointer border border-border-subtle bg-transparent p-0 block" />
                     <span className="text-xs font-mono">{colorBuyStrong.toUpperCase()}</span>
                   </div>
                </div>
                <div>
                   <p className="text-xs text-text-muted mb-1">做空/阻力线 (普通)</p>
                   <div className="flex items-center space-x-2">
                     <input type="color" value={colorSell} onChange={e=>setColorSell(e.target.value)} className="w-8 h-8 rounded shrink-0 cursor-pointer border border-border-subtle bg-transparent p-0 block" />
                     <span className="text-xs font-mono">{colorSell.toUpperCase()}</span>
                   </div>
                </div>
                <div>
                   <p className="text-xs text-text-muted mb-1">做空/阻力线 (强共振)</p>
                   <div className="flex items-center space-x-2">
                     <input type="color" value={colorSellStrong} onChange={e=>setColorSellStrong(e.target.value)} className="w-8 h-8 rounded shrink-0 cursor-pointer border border-border-subtle bg-transparent p-0 block" />
                     <span className="text-xs font-mono">{colorSellStrong.toUpperCase()}</span>
                   </div>
                </div>
                <div>
                   <p className="text-xs text-text-muted mb-1">价格标签字色 (含柱体)</p>
                   <div className="flex items-center space-x-2">
                     <input type="color" value={colorLabelText} onChange={e=>setColorLabelText(e.target.value)} className="w-8 h-8 rounded shrink-0 cursor-pointer border border-border-subtle bg-transparent p-0 block" />
                     <span className="text-xs font-mono">{colorLabelText.toUpperCase()}</span>
                   </div>
                </div>
              </div>
            </div>

            <div className="pb-4">
              <label className="block text-sm font-medium text-text-muted mb-2 flex justify-between sm:w-64">
                <span>线条整体粗细加倍系数</span>
                <span className="font-mono text-fib-a">x{lineWidthScalar}</span>
              </label>
              <input 
                type="range" min="1" max="4" step="1"
                value={lineWidthScalar} onChange={e => setLineWidthScalar(Number(e.target.value))}
                className="w-full sm:w-64 accent-fib-a cursor-pointer"
              />
              <p className="mt-2 text-xs text-text-muted">图表中将基于星级乘以该系数，动态增粗或减细视觉线条。</p>
            </div>
            
            <button 
              onClick={handleSaveStandard}
              className="flex items-center space-x-2 bg-fib-a text-white px-6 py-2.5 rounded-md hover:bg-fib-a/90 transition-colors font-medium text-sm"
            >
              <Save className="w-4 h-4" />
              <span>保存本地参数</span>
            </button>
          </div>
        </section>

        <section className="bg-bg-card border border-border-subtle rounded-xl p-6">
          <h2 className="text-xl font-semibold mb-6 flex items-center">
            <span className="w-2 h-6 bg-blue-500 rounded mr-3"></span>
            HyperLiquid 交易所配置
          </h2>
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-text-muted mb-2">
                钱包地址 (公开公钥 Address)
              </label>
              <input 
                type="text"
                value={hlAddress}
                onChange={(e) => setHlAddress(e.target.value)}
                className="w-full bg-bg-main border border-border-subtle text-text-main rounded-md px-4 py-2 focus:outline-none focus:border-blue-500 font-mono text-sm"
                placeholder="0x..."
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-text-muted mb-2">
                API 密钥 (钱包私钥 Private Key)
              </label>
              <div className="relative">
                <input 
                  type={showKey ? "text" : "password"}
                  value={hlPrivateKey}
                  onChange={(e) => setHlPrivateKey(e.target.value)}
                  className="w-full bg-bg-main border border-border-subtle text-text-main rounded-md px-4 py-2 pr-10 focus:outline-none focus:border-blue-500 font-mono text-sm"
                  placeholder="填写用于执行链上操作的私钥"
                />
                <button 
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="mt-2 text-xs text-text-muted">私钥会保存在当前浏览器的 Local Storage 中；部署订单时会发送到本机 API 路由，由服务端 SDK 签名并提交到 HyperLiquid。</p>
            </div>

            <div className="pt-2">
              <button 
                onClick={handleTestConnection}
                disabled={testing}
                className={`flex items-center space-x-2 px-6 py-2.5 rounded-md font-medium text-sm transition-colors ${testing ? 'bg-bg-main text-text-muted border border-border-subtle cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
              >
                {testing ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-text-muted" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    <span>正在测试连接...</span>
                  </>
                ) : (
                  <>
                    <span>测试连接并读取数据</span>
                  </>
                )}
              </button>
            </div>

            {errorMSG && (
              <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-md flex items-start space-x-3 text-red-500">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-sm font-medium">{errorMSG}</p>
              </div>
            )}

            {testResult && (
              <div className="mt-8 space-y-6">
                <div className="p-4 bg-fib-a/10 border border-fib-a/20 rounded-md flex items-center space-x-3 text-fib-a mb-6">
                  <CheckCircle2 className="w-5 h-5" />
                  <p className="text-sm font-bold tracking-wide">连接验证成功</p>
                </div>

                <div className="p-5 bg-bg-main rounded-lg border border-border-subtle">
                  <h3 className="text-sm font-semibold text-text-muted mb-1 pb-2 border-b border-border-subtle/50">合约账户净值 (Perp Account Value)</h3>
                  <p className="text-3xl font-bold font-mono text-text-main py-2">${parseFloat(testResult.balance).toFixed(2)}</p>
                </div>

                <div className="p-5 bg-bg-main rounded-lg border border-border-subtle">
                  <h3 className="text-sm font-semibold text-text-muted mb-4 pb-2 border-b border-border-subtle/50">当前持仓 (Open Positions)</h3>
                  {testResult.positions.length === 0 ? (
                    <p className="text-sm text-text-muted font-mono">暂无任何活跃持仓。</p>
                  ) : (
                    <div className="space-y-3">
                      {testResult.positions.map((p: any, i: number) => {
                        const pos = p.position;
                        const isLong = parseFloat(pos.szi) > 0;
                        const pnl = parseFloat(pos.unrealizedPnl);
                        return (
                          <div key={i} className="flex items-center justify-between p-3 bg-bg-card rounded border border-border-subtle">
                            <div className="flex items-center space-x-3">
                              <span className={`px-2 py-0.5 text-[10px] font-bold rounded ${isLong ? 'bg-kline-up/20 text-kline-up' : 'bg-kline-down/20 text-kline-down'}`}>
                                {isLong ? '做多' : '做空'}
                              </span>
                              <span className="font-bold text-sm">{pos.coin}</span>
                            </div>
                            <div className="text-right">
                              <div className="text-sm font-mono">{Math.abs(parseFloat(pos.szi))} {pos.coin}</div>
                              <div className={`text-xs font-mono ${pnl >= 0 ? 'text-kline-up' : 'text-kline-down'}`}>
                                {pnl > 0 ? '+' : ''}{pnl.toFixed(2)} USDT
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                <div className="p-5 bg-bg-main rounded-lg border border-border-subtle">
                  <h3 className="text-sm font-semibold text-text-muted mb-4 pb-2 border-b border-border-subtle/50">近期成交 (Recent Fills)</h3>
                  {testResult.fills.length === 0 ? (
                    <p className="text-sm text-text-muted font-mono">暂无历史成交记录。</p>
                  ) : (
                    <div className="space-y-2">
                       {testResult.fills.map((f: any, i: number) => {
                         const timeStr = new Date(f.time).toLocaleString('zh-CN');
                         const isBuy = f.side === 'B';
                         return (
                           <div key={i} className="flex items-center justify-between text-xs p-2 hover:bg-bg-card rounded transition-colors font-mono">
                             <div className="flex items-center space-x-4">
                                <span className={`w-8 font-bold ${isBuy ? 'text-kline-up' : 'text-kline-down'}`}>{isBuy ? '买入' : '卖出'}</span>
                                <span className="font-bold w-12">{f.coin}</span>
                                <span className="text-text-muted">{timeStr}</span>
                             </div>
                             <div className="text-right flex space-x-4">
                               <span className="text-text-muted">{f.sz}</span>
                               <span>@ ${parseFloat(f.px).toFixed(Math.max(2, f.px.split('.')[1]?.length || 0))}</span>
                             </div>
                           </div>
                         )
                       })}
                    </div>
                  )}
                </div>

              </div>
            )}
            
          </div>
        </section>
      </div>
    </div>
  );
}
