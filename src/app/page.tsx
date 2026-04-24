'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, IChartApi, IPriceLine, ISeriesApi, Time, CandlestickSeries, LineSeries } from 'lightweight-charts';
import { Sun, Moon, Check, Zap, Wallet, BarChart, Settings as SettingsIcon, AlertCircle, Loader2, ChevronDown, DollarSign, Pencil, RotateCcw } from 'lucide-react';
import Link from 'next/link';

type HLCandle = { t: number; T: number; s: string; i: string; o: string; h: string; l: string; c: string; v: string; n: number; };
type CoinConfig = { assetIndex: number; szDecimals: number; };

const HL_API = 'https://api.hyperliquid.xyz/info';
const INTERVAL_MS: Record<string, number> = {
  '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000,
};

function getPerpAccountValue(data: any): number {
  return parseFloat(data?.marginSummary?.accountValue) || 0;
}

async function fetchHLCandles(coin: string, interval: string, startTime: number, endTime?: number): Promise<HLCandle[]> {
  const req: any = { coin, interval, startTime };
  if (endTime) req.endTime = endTime;
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req }),
  });
  if (!res.ok) throw new Error(`HyperLiquid ${interval} K线拉取失败`);
  return res.json();
}

async function fetch2200Candles(coin: string, interval: string): Promise<HLCandle[]> {
  const ms = INTERVAL_MS[interval] ?? INTERVAL_MS['1h'];
  return fetchHLCandles(coin, interval, Date.now() - 2200 * ms);
}

function getHighLow(candles: HLCandle[]): { high: number; low: number } {
  let high = -Infinity;
  let low = Infinity;
  for (const k of candles) {
    const h = parseFloat(k.h);
    const l = parseFloat(k.l);
    if (h > high) high = h;
    if (l < low) low = l;
  }
  return { high, low };
}

function calcEMA(data: { time: Time; close: number }[], period: number): { time: Time; value: number }[] {
  const k = 2 / (period + 1);
  const result: { time: Time; value: number }[] = [];
  let ema = 0;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      ema = data.slice(0, period).reduce((s, d) => s + d.close, 0) / period;
    } else {
      ema = data[i].close * k + ema * (1 - k);
    }
    result.push({ time: data[i].time, value: ema });
  }
  return result;
}

const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

function calcFibonacciLevels(high: number, low: number): number[] {
  const diff = high - low;
  return FIB_RATIOS.map((ratio) => low + diff * ratio);
}

// Generate the Confluence Order Matrix
function generateMatrix(fibs1D: number[], fibs4H: number[], currentPrice: number, tolerancePct: number, totalUsdt: number, depthScale: number) {
  if (!currentPrice || currentPrice === 0) return [];
  
  const allFibs = [
    ...fibs1D.map(p => ({ price: p, weight: 2, source: '1D' })),
    ...fibs4H.map(p => ({ price: p, weight: 1, source: '4H' }))
  ].sort((a, b) => a.price - b.price);

  if (allFibs.length === 0) return [];

  const clusters: { price: number, weight: number, displayWeight: number }[] = [];
  let curr = { priceSum: allFibs[0].price, weight: allFibs[0].weight, count: 1 };

  for (let i = 1; i < allFibs.length; i++) {
    const p = allFibs[i].price;
    const avg = curr.priceSum / curr.count;
    if (Math.abs(p - avg) / avg <= (tolerancePct / 100)) {
      curr.priceSum += p;
      curr.weight += allFibs[i].weight;
      curr.count++;
    } else {
      clusters.push({ price: curr.priceSum / curr.count, weight: curr.weight, displayWeight: curr.weight });
      curr = { priceSum: p, weight: allFibs[i].weight, count: 1 };
    }
  }
  clusters.push({ price: curr.priceSum / curr.count, weight: curr.weight, displayWeight: curr.weight });

  // Apply Depth Scale (Martingale effect): Further clusters get higher volume weight
  const buys = clusters.filter(c => c.price < currentPrice).sort((a,b) => b.price - a.price);
  buys.forEach((c, i) => c.weight = c.weight * (1 + i * depthScale));

  const sells = clusters.filter(c => c.price >= currentPrice).sort((a,b) => a.price - b.price);
  sells.forEach((c, i) => c.weight = c.weight * (1 + i * depthScale));

  const allClusters = [...buys, ...sells];
  const totalWeight = allClusters.reduce((sum, c) => sum + c.weight, 0);

  return allClusters.map(c => {
    const side = c.price > currentPrice ? 'Sell' : 'Buy';
    const usdtAlloc = totalWeight > 0 ? (c.weight / totalWeight) * totalUsdt : 0;
    const btcSize = usdtAlloc / c.price;
    return {
      price: c.price,
      side,
      weight: c.displayWeight, // Star ratings in UI stay the same
      volumeWeight: c.weight, // Actual weight used for volume sizing
      usdt: usdtAlloc,
      sizeStr: btcSize.toFixed(4),
      active: true, // By default, all generated orders are ticked for deployment
      isManual: false
    };
  }).sort((a, b) => b.price - a.price);
}

export default function Home() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const emaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lastEmaRef = useRef<number>(0);
  const matrixLinesRef = useRef<IPriceLine[]>([]);
  const openOrderLinesRef = useRef<IPriceLine[]>([]);
  const openOrdersRef = useRef<OpenOrder[]>([]);
  const positionLineRef = useRef<IPriceLine | null>(null);
  const hlPositionsRef = useRef<any[]>([]);
  const activeCoinRef = useRef<string>('BTC');

  const [loading, setLoading] = useState(true);
  const [errorMSG, setErrorMSG] = useState<string | null>(null);
  
  const [activeInterval, setActiveInterval] = useState<string>('1h');
  const [chartData, setChartData] = useState<any[] | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number>(0);

  const [fibGroupA, setFibGroupA] = useState<number[] | null>(null);
  const [fibGroupB, setFibGroupB] = useState<number[] | null>(null);

  const [showFibA, setShowFibA] = useState(true);
  const [showFibB, setShowFibB] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Strategy Panel States
  // null = 加载中；[] = 无持仓；非空数组 = 持仓列表
  const [hlPositions, setHlPositions] = useState<any[] | null>(null);
  const [tolerance, setTolerance] = useState<number>(0.5);
  const [depthScale, setDepthScale] = useState<number>(0.2);
  const [totalCapital, setTotalCapital] = useState<number>(1000);
  const [leverage, setLeverage] = useState<number>(10);
  const [accountValue, setAccountValue] = useState<number>(0);
  const [balanceHistory, setBalanceHistory] = useState<{ ts: number; value: number }[]>([]);
  const balanceHistoryRef = useRef<{ ts: number; value: number }[]>([]);
  const [manualOrderOverrides, setManualOrderOverrides] = useState<Record<string, { active?: boolean; sizeStr?: string; isManual?: boolean; priceStr?: string; isManualPrice?: boolean }>>({});
  const [editingPriceIndex, setEditingPriceIndex] = useState<number>(-1);
  const [priceDraft, setPriceDraft] = useState<string>('');

  const [sidebarWidth, setSidebarWidth] = useState(580);
  const [sidebarTab, setSidebarTab] = useState<'orders' | 'openOrders' | 'params' | 'balance'>('orders');
  const [sidebarZoom, setSidebarZoom] = useState(1.0);
  const isResizingRef = useRef(false);
  const hasMountedRef = useRef(false);

  // 交易对选择
  const [activeCoin, setActiveCoin] = useState('BTC');
  const [coinMetaMap, setCoinMetaMap] = useState<Record<string, CoinConfig>>({});
  const [coinDropdownOpen, setCoinDropdownOpen] = useState(false);
  const [coinSearch, setCoinSearch] = useState('');
  const coinDropdownRef = useRef<HTMLDivElement>(null);

  const [reduceOnlySells, setReduceOnlySells] = useState(true);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{status: 'success' | 'err', msg: string} | null>(null);
  const [paramNotice, setParamNotice] = useState<string | null>(null);
  const paramNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 现有订单
  type OpenOrder = { coin: string; side: string; limitPx: string; sz: string; oid: number; timestamp: number; origSz: string; orderType?: string; triggerPx?: string; triggerCondition?: string; };
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [isFetchingOpenOrders, setIsFetchingOpenOrders] = useState(false);
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<number>>(new Set());
  const [isCanceling, setIsCanceling] = useState(false);
  const [cancelResult, setCancelResult] = useState<{status: 'success' | 'err', msg: string} | null>(null);

  const orderKey = (price: number) => price.toFixed(8);

  const generatedMatrix = useMemo(() => {
    if (currentPrice <= 0) return [];
    const input1D = showFibA && fibGroupA ? fibGroupA : [];
    const input4H = showFibB && fibGroupB ? fibGroupB : [];
    return generateMatrix(input1D, input4H, currentPrice, tolerance, totalCapital, depthScale);
  }, [fibGroupA, fibGroupB, showFibA, showFibB, currentPrice, tolerance, totalCapital, depthScale]);

  const matrix = useMemo(() => {
    const merged = generatedMatrix.map((gen) => {
      const existing = manualOrderOverrides[orderKey(gen.price)];
      const base = {
        ...gen,
        origPrice: gen.price,
        isManualPrice: false as boolean,
      };
      if (!existing) return base;
      let price = gen.price;
      let isManualPrice = false;
      if (existing.isManualPrice && existing.priceStr !== undefined) {
        const parsed = parseFloat(existing.priceStr);
        if (!isNaN(parsed) && parsed > 0) {
          price = parsed;
          isManualPrice = true;
        }
      }
      const side: 'Buy' | 'Sell' = price > currentPrice ? 'Sell' : 'Buy';
      return {
        ...base,
        price,
        side,
        active: existing.active ?? gen.active,
        sizeStr: existing.isManual ? (existing.sizeStr ?? gen.sizeStr) : gen.sizeStr,
        isManual: Boolean(existing.isManual),
        isManualPrice,
      };
    });
    return merged.sort((a, b) => b.price - a.price);
  }, [generatedMatrix, manualOrderOverrides, currentPrice]);

  const allActive = matrix.length > 0 && matrix.every(m => m.active);

  const selectWhere = (predicate: (m: typeof matrix[0]) => boolean) => {
    setManualOrderOverrides(prev => {
      const updated = { ...prev };
      matrix.forEach(m => {
        const k = orderKey(m.origPrice);
        updated[k] = { ...prev[k], active: predicate(m) };
      });
      return updated;
    });
  };

  const toggleSelectAll = () => selectWhere(() => !allActive);

  const getFibParam = () => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('fibParam');
      if (stored) return parseInt(stored, 10) || 89;
    }
    return 89;
  };

  const getVisibleCandles = () => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('visibleCandles');
      if (stored) return Math.max(50, Math.min(2200, parseInt(stored, 10) || 200));
    }
    return 200;
  };

  const applyNewTotalCapital = (newCap: number) => {
    setTotalCapital(newCap);
    setManualOrderOverrides({});
  };

  const handleCapitalChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    applyNewTotalCapital(Number(e.target.value));
  };

  const toggleOrderActive = (index: number) => {
    const order = matrix[index];
    if (!order) return;
    const k = orderKey(order.origPrice);
    setManualOrderOverrides((prev) => ({
      ...prev,
      [k]: {
        ...prev[k],
        active: !order.active,
      },
    }));
  };

  const handleOrderSizeChange = (index: number, newSize: string) => {
    const order = matrix[index];
    if (!order) return;
    const k = orderKey(order.origPrice);

    const newMatrix = matrix.map((m, i) => i === index ? { ...m, sizeStr: newSize, isManual: true } : m);
    setManualOrderOverrides((prev) => ({
      ...prev,
      [k]: {
        ...prev[k],
        sizeStr: newSize,
        isManual: true,
      },
    }));

    const updatedCap = newMatrix.reduce((sum, m) => {
      const sz = parseFloat(m.sizeStr) || 0;
      return sum + (sz * m.price);
    }, 0);
    setTotalCapital(Math.round(updatedCap));
  };

  const commitOrderPrice = (index: number, newPriceStr: string) => {
    const order = matrix[index];
    if (!order) return;
    const k = orderKey(order.origPrice);
    const parsed = parseFloat(newPriceStr);
    setManualOrderOverrides((prev) => {
      const cur = prev[k] ?? {};
      // 非法输入或等于原价：视为恢复默认
      if (isNaN(parsed) || parsed <= 0 || Math.abs(parsed - order.origPrice) < 1e-9) {
        const { priceStr: _p, isManualPrice: _i, ...rest } = cur;
        return { ...prev, [k]: rest };
      }
      return {
        ...prev,
        [k]: { ...cur, priceStr: String(parsed), isManualPrice: true },
      };
    });
    setEditingPriceIndex(-1);
  };

  const resetOrderPrice = (index: number) => {
    const order = matrix[index];
    if (!order) return;
    const k = orderKey(order.origPrice);
    setManualOrderOverrides((prev) => {
      const cur = prev[k];
      if (!cur) return prev;
      const { priceStr: _p, isManualPrice: _i, ...rest } = cur;
      return { ...prev, [k]: rest };
    });
  };

  const handleDeployOrders = async () => {
    const activeOrders = matrix.filter(m => m.active);
    if (activeOrders.length === 0) {
      setDeployResult({ status: 'err', msg: '没有勾选要部署的订单' });
      return;
    }
    const pk = typeof window !== 'undefined' ? localStorage.getItem('hlPrivateKey') : null;
    const masterAddress = typeof window !== 'undefined' ? localStorage.getItem('hlAddress') : null;
    if (!pk) {
      setDeployResult({ status: 'err', msg: '缺少私钥，请前往右上角设置页面配置 API Key' });
      return;
    }
    if (!masterAddress) {
      setDeployResult({ status: 'err', msg: '缺少 Master 地址，请前往右上角设置页面配置主网 master 地址' });
      return;
    }

    setIsDeploying(true);
    setDeployResult(null);

    try {
      const coinCfg = coinMetaMap[activeCoin];
      const LOT_SIZE = coinCfg ? Math.pow(10, -coinCfg.szDecimals) : 0.001;
      const ASSET_INDEX = coinCfg?.assetIndex ?? 0;
      const SZ_DECIMALS = coinCfg?.szDecimals ?? 3;
      const COIN_PERP = `${activeCoin}-PERP`;

      const bulkOrders = activeOrders
        .map(m => {
          const isBuy = m.side === 'Buy';
          const rawSz = parseFloat(m.sizeStr) || 0;
          const sz = parseFloat((Math.floor(rawSz / LOT_SIZE) * LOT_SIZE).toFixed(SZ_DECIMALS));
          const px = parseFloat(m.price.toPrecision(5));
          const reduce_only = !isBuy && reduceOnlySells;
          return { coin: COIN_PERP, is_buy: isBuy, sz, limit_px: px, order_type: { limit: { tif: 'Gtc' } }, reduce_only };
        })
        .filter(o => o.sz >= LOT_SIZE);

      if (bulkOrders.length === 0) {
        setDeployResult({ status: 'err', msg: `所有订单数量均低于最小下单量 ${LOT_SIZE} ${activeCoin}，请调大总规模或减少网格数量` });
        setIsDeploying(false);
        return;
      }

      console.log('Sending Action payload formatted for HL SDK:', {
        orders: bulkOrders
      });

      // 3. Dispatch bulk limit orders to Hyperliquid L1 node via our secure internal API Route
      const res = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: pk, masterAddress, orders: bulkOrders, assetIndex: ASSET_INDEX, szDecimals: SZ_DECIMALS })
      });
      
      const response = await res.json();
      console.log('Hyperliquid Deployment Response:', response);

      if (response && response.status === 'ok') {
        const errorStatuses = response?.response?.data?.statuses?.filter((s:any) => s.error);
        if (errorStatuses && errorStatuses.length > 0) {
           setDeployResult({ status: 'err', msg: `部分订单失败: ${errorStatuses[0].error}` });
        } else {
           setDeployResult({ status: 'success', msg: `成功在主网执行了 ${bulkOrders.length} 个限价单部署!` });
        }
      } else {
        setDeployResult({ status: 'err', msg: `部署失败: ${response.msg || JSON.stringify(response)}` });
      }

    } catch (e: any) {
      console.error(e);
      setDeployResult({ status: 'err', msg: '签名或发送交易失败: ' + e.message });
    } finally {
      setIsDeploying(false);
      setTimeout(() => setDeployResult(null), 5000); // clear after 5s
    }
  };

  const drawOpenOrderLines = (orders: OpenOrder[], coin: string) => {
    if (!seriesRef.current) return;
    openOrderLinesRef.current.forEach(line => seriesRef.current?.removePriceLine(line));
    openOrderLinesRef.current = [];
    const matched = orders.filter(o => o.coin === coin || o.coin === `${coin}-PERP`);
    matched.forEach(o => {
      const triggerPx = parseFloat(o.triggerPx ?? '0');
      const px = triggerPx > 0 ? triggerPx : parseFloat(o.limitPx);
      if (isNaN(px) || px <= 0) return;
      const isBuy = o.side === 'B';
      const sideZh = isBuy ? '买' : '卖';
      const typeZh = triggerPx > 0 ? (o.triggerCondition === 'above' ? '止盈' : '止损') : '限价';
      const line = seriesRef.current!.createPriceLine({
        price: px,
        color: '#1E3A5F',
        lineWidth: 1,
        lineStyle: 3,
        axisLabelVisible: true,
        axisLabelTextColor: '#FFFFFF',
        title: `◆ ${sideZh}${typeZh} ${o.sz}`,
      });
      openOrderLinesRef.current.push(line);
    });
  };

  const drawPositionLine = (positions: any[] | null, coin: string) => {
    if (!seriesRef.current) return;
    if (positionLineRef.current) {
      seriesRef.current.removePriceLine(positionLineRef.current);
      positionLineRef.current = null;
    }
    if (!positions || positions.length === 0) return;
    const pos = positions.find(p => p?.coin === coin);
    if (!pos) return;
    const entryPx = parseFloat(pos.entryPx);
    const szi = parseFloat(pos.szi);
    if (isNaN(entryPx) || entryPx <= 0) return;
    const isLong = szi > 0;
    positionLineRef.current = seriesRef.current.createPriceLine({
      price: entryPx,
      color: '#FFD700',
      lineWidth: 2,
      lineStyle: 2,
      axisLabelVisible: true,
      axisLabelTextColor: '#000000',
      title: `● ${isLong ? '多' : '空'} ${Math.abs(szi)}`,
    });
  };

  const fetchOpenOrders = async () => {
    const addr = typeof window !== 'undefined' ? localStorage.getItem('hlAddress') : null;
    if (!addr) return;
    setIsFetchingOpenOrders(true);
    setCancelResult(null);
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'frontendOpenOrders', user: addr }),
      });
      const data = await res.json();
      const orders = Array.isArray(data) ? data : [];
      openOrdersRef.current = orders;
      setOpenOrders(orders);
      setSelectedOrderIds(new Set());
      drawOpenOrderLines(orders, activeCoinRef.current);
    } catch {
      openOrdersRef.current = [];
      setOpenOrders([]);
    } finally {
      setIsFetchingOpenOrders(false);
    }
  };

  // orders: { oid, coin } — coin 用于从 coinMetaMap 取 assetIndex
  const handleCancelOrders = async (orders: { oid: number; coin: string }[]) => {
    const pk = typeof window !== 'undefined' ? localStorage.getItem('hlPrivateKey') : null;
    if (!pk) { setCancelResult({ status: 'err', msg: '缺少私钥' }); return; }
    setIsCanceling(true);
    setCancelResult(null);
    const cancels = orders.map(o => ({
      oid: o.oid,
      assetIndex: coinMetaMap[o.coin]?.assetIndex ?? 0,
    }));
    try {
      const res = await fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: pk, cancels }),
      });
      const data = await res.json();
      if (data?.status === 'ok' || data?.response?.type === 'cancel') {
        setCancelResult({ status: 'success', msg: `已取消 ${orders.length} 个订单` });
        await fetchOpenOrders();
      } else {
        setCancelResult({ status: 'err', msg: data?.msg || JSON.stringify(data) });
      }
    } catch (e: any) {
      setCancelResult({ status: 'err', msg: e.message });
    } finally {
      setIsCanceling(false);
      setTimeout(() => setCancelResult(null), 5000);
    }
  };

  // 从 localStorage 加载（mount 时）；persist effects 在 mount 第一次 render 时跳过，避免覆盖存储值
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sl = localStorage.getItem('leverage');
    if (sl) setLeverage(parseInt(sl, 10) || 10);
    const sc = localStorage.getItem('totalCapital');
    if (sc) setTotalCapital(parseInt(sc, 10) || 1000);
    const sz = localStorage.getItem('sidebarZoom');
    if (sz) setSidebarZoom(parseFloat(sz) || 1.0);
    const coin = localStorage.getItem('activeCoin');
    if (coin) setActiveCoin(coin);
    const stol = localStorage.getItem('tolerance');
    if (stol) setTolerance(parseFloat(stol) || 0.5);
    const sds = localStorage.getItem('depthScale');
    if (sds) setDepthScale(parseFloat(sds) || 0.2);
    const stheme = localStorage.getItem('theme');
    if (stheme === 'light' || stheme === 'dark') setTheme(stheme);
    const sfibA = localStorage.getItem('showFibA');
    if (sfibA !== null) setShowFibA(sfibA !== 'false');
    const sfibB = localStorage.getItem('showFibB');
    if (sfibB !== null) setShowFibB(sfibB !== 'false');
    const sgrid = localStorage.getItem('showGrid');
    if (sgrid !== null) setShowGrid(sgrid === 'true');
    const sros = localStorage.getItem('reduceOnlySells');
    if (sros !== null) setReduceOnlySells(sros !== 'false');
    const sint = localStorage.getItem('activeInterval');
    if (sint) setActiveInterval(sint);
    try {
      const sbh = localStorage.getItem('balanceHistory');
      if (sbh) {
        const parsed = JSON.parse(sbh);
        if (Array.isArray(parsed)) {
          const clean = parsed.filter((e: any) => typeof e?.ts === 'number' && typeof e?.value === 'number');
          balanceHistoryRef.current = clean;
          setBalanceHistory(clean);
        }
      }
    } catch {}
    hasMountedRef.current = true;
    fetchOpenOrders();
  }, []);

  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('leverage', String(leverage)); }, [leverage]);
  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('totalCapital', String(totalCapital)); }, [totalCapital]);
  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('sidebarZoom', String(sidebarZoom)); }, [sidebarZoom]);
  useEffect(() => {
    activeCoinRef.current = activeCoin;
    if (!hasMountedRef.current) return;
    localStorage.setItem('activeCoin', activeCoin);
    drawOpenOrderLines(openOrdersRef.current, activeCoin);
    drawPositionLine(hlPositionsRef.current, activeCoin);
  }, [activeCoin]);
  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('tolerance', String(tolerance)); }, [tolerance]);
  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('depthScale', String(depthScale)); }, [depthScale]);
  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('theme', theme); }, [theme]);
  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('showFibA', String(showFibA)); }, [showFibA]);
  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('showFibB', String(showFibB)); }, [showFibB]);
  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('showGrid', String(showGrid)); }, [showGrid]);
  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('reduceOnlySells', String(reduceOnlySells)); }, [reduceOnlySells]);
  useEffect(() => { if (!hasMountedRef.current) return; localStorage.setItem('activeInterval', activeInterval); }, [activeInterval]);

  // 拉取 HL 所有交易对元数据（asset index、szDecimals）
  useEffect(() => {
    fetch(HL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' }),
    })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data?.universe)) {
          const map: Record<string, CoinConfig> = {};
          data.universe.forEach((asset: any, i: number) => {
            map[asset.name] = { assetIndex: i, szDecimals: asset.szDecimals };
          });
          setCoinMetaMap(map);
        }
      })
      .catch(console.error);
  }, []);

  // 点击下拉框外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (coinDropdownRef.current && !coinDropdownRef.current.contains(e.target as Node)) {
        setCoinDropdownOpen(false);
        setCoinSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Fetch HL account value and all open positions
  useEffect(() => {
    const fetchPos = async () => {
      if (typeof window === 'undefined') return;
      const addr = localStorage.getItem('hlAddress');
      if (!addr) return;
      try {
        const perpRes = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: addr })
        });
        const perpData = await perpRes.json();
        setAccountValue(getPerpAccountValue(perpData));
        const positions = Array.isArray(perpData?.assetPositions)
          ? perpData.assetPositions.map((p: any) => p.position)
          : [];
        hlPositionsRef.current = positions;
        setHlPositions(positions);
        drawPositionLine(positions, activeCoinRef.current);

        // 余额快照：含浮盈的账户总权益（accountValue），每 24h 追加一条
        const balance = parseFloat(perpData?.marginSummary?.accountValue);
        if (!isNaN(balance) && balance > 0) {
          const now = Date.now();
          const history = balanceHistoryRef.current;
          const last = history[history.length - 1];
          if (!last || now - last.ts >= 24 * 60 * 60 * 1000) {
            const next = [...history, { ts: now, value: balance }];
            balanceHistoryRef.current = next;
            setBalanceHistory(next);
            try { localStorage.setItem('balanceHistory', JSON.stringify(next)); } catch {}
          }
        }
      } catch (e) {
        console.error("HL Fetch Error", e);
      }
    };
    fetchPos();
    const interval = setInterval(fetchPos, 10000);
    return () => clearInterval(interval);
  }, []);

  // Theme Config Applicator
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    
    if (chartRef.current) {
      chartRef.current.applyOptions({
        layout: {
          background: { color: theme === 'dark' ? '#0B0E11' : '#FAFAFA' },
          textColor: theme === 'dark' ? '#EAECEF' : '#1E2329',
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { visible: showGrid, color: theme === 'dark' ? '#2B2F36' : '#EAECEF' },
        },
      });
    }
    if (emaSeriesRef.current) {
      emaSeriesRef.current.applyOptions({
        color: theme === 'dark' ? '#6B7280' : '#9CA3AF',
      });
    }
  }, [theme, showGrid]);

  // Chart Initialization
  useEffect(() => {
    if (!chartContainerRef.current) return;
    
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: theme === 'dark' ? '#0B0E11' : '#FAFAFA' },
        textColor: theme === 'dark' ? '#EAECEF' : '#1E2329',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false, color: theme === 'dark' ? '#2B2F36' : '#EAECEF' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: 'transparent',
      downColor: '#CF304A',
      borderVisible: true,
      borderUpColor: '#02C076',
      borderDownColor: '#CF304A',
      wickUpColor: '#02C076',
      wickDownColor: '#CF304A',
    });

    const emaSeries = chart.addSeries(LineSeries, {
      color: '#6B7280',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    emaSeriesRef.current = emaSeries;
    drawOpenOrderLines(openOrdersRef.current, activeCoinRef.current);
    drawPositionLine(hlPositionsRef.current, activeCoinRef.current);

    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    
    if (chartContainerRef.current) {
      resizeObserver.observe(chartContainerRef.current);
    }

    return () => {
      if (chartContainerRef.current) {
        // eslint-disable-next-line react-hooks/exhaustive-deps
        resizeObserver.unobserve(chartContainerRef.current);
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      emaSeriesRef.current = null;
      positionLineRef.current = null;
      openOrderLinesRef.current = [];
      matrixLinesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wsRef = useRef<WebSocket | null>(null);

  // Fetch Data on Interval Change
  useEffect(() => {
    let isMounted = true;
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const fetchAllData = async () => {
      try {
        setLoading(true);
        setErrorMSG(null);

        const fibParam = getFibParam();
        const now = Date.now();
        const [klineData, kline1D, kline4H] = await Promise.all([
          fetch2200Candles(activeCoin, activeInterval),
          fetchHLCandles(activeCoin, '1d', now - fibParam * INTERVAL_MS['1d']),
          fetchHLCandles(activeCoin, '4h', now - fibParam * INTERVAL_MS['4h']),
        ]);

        if (!isMounted) return;

        const hl1D = getHighLow(kline1D);
        const fibsA = calcFibonacciLevels(hl1D.high, hl1D.low);
        const hl4H = getHighLow(kline4H);
        const fibsB = calcFibonacciLevels(hl4H.high, hl4H.low);

        let latestC = 0;
        const mappedData = klineData.map((k) => {
          const c = parseFloat(k.c);
          latestC = c;
          return {
            time: (k.t / 1000) as Time,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
          };
        });

        setChartData(mappedData);
        setCurrentPrice(latestC);
        setFibGroupA(fibsA);
        setFibGroupB(fibsB);
      } catch (err: any) {
        if (isMounted) setErrorMSG(err.message || 'Error fetching data');
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    
    fetchAllData();

    const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'candle', coin: activeCoin, interval: activeInterval },
      }));
    };

    ws.onmessage = (event) => {
      if (!isMounted) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.channel === 'candle' && msg.data?.i === activeInterval) {
          const k = msg.data;
          const tick = {
            time: (k.t / 1000) as Time,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
          };
          if (seriesRef.current) seriesRef.current.update(tick);
          if (emaSeriesRef.current && lastEmaRef.current) {
            const k = 2 / 21;
            const newEma = tick.close * k + lastEmaRef.current * (1 - k);
            lastEmaRef.current = newEma;
            emaSeriesRef.current.update({ time: tick.time, value: newEma });
          }
          setCurrentPrice(tick.close);
        }
      } catch (e) {
        console.error('WS Parse Error', e);
      }
    };

    return () => {
      isMounted = false;
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            method: 'unsubscribe',
            subscription: { type: 'candle', coin: activeCoin, interval: activeInterval },
          }));
        }
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [activeInterval, activeCoin]);

  // Reactive Update: K-Line Data
  useEffect(() => {
    if (seriesRef.current && chartData && chartData.length > 0) {
      seriesRef.current.setData(chartData);

      if (emaSeriesRef.current) {
        const emaData = calcEMA(chartData, 20);
        emaSeriesRef.current.setData(emaData);
        if (emaData.length > 0) lastEmaRef.current = emaData[emaData.length - 1].value;
      }

      const count = getVisibleCandles();
      const total = chartData.length;
      const rightPad = 30;
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: total - count,
        to: total - 1 + rightPad,
      });
    }
  }, [chartData]);

  const getVisualParams = () => {
    if (typeof window !== 'undefined') {
      return {
        buy: localStorage.getItem('colorBuy') || '#02C076',
        buyStrong: localStorage.getItem('colorBuyStrong') || '#00FF9D',
        sell: localStorage.getItem('colorSell') || '#CF304A',
        sellStrong: localStorage.getItem('colorSellStrong') || '#FF4B6A',
        labelText: localStorage.getItem('colorLabelText') || '#FFFFFF',
        lwScalar: Number(localStorage.getItem('lineWidthScalar')) || 1,
      };
    }
    return { buy: '#02C076', buyStrong: '#00FF9D', sell: '#CF304A', sellStrong: '#FF4B6A', lwScalar: 1 };
  };

  // Reactive Update: Confluence Matrix Lines on Chart
  useEffect(() => {
    if (!seriesRef.current) return;
    
    const targetLines = matrixLinesRef.current;
    const vp = getVisualParams();

    // Check if the lines need a full rebuild (e.g. quantity of lines changed due to tolerance shift)
    if (targetLines.length !== matrix.length) {
      targetLines.forEach(line => seriesRef.current?.removePriceLine(line));
      targetLines.length = 0;
      
      const maxSize = Math.max(...matrix.map(m => parseFloat(m.sizeStr) || 0), 0.0001);

      matrix.forEach((m) => {
        let color = m.side === 'Buy' ? vp.buy : vp.sell;

        let ls = 1;
        let baseLw = 1;
        if (m.weight === 2) { ls = 2; }
        else if (m.weight >= 3) { ls = 0; color = m.side === 'Buy' ? vp.buyStrong : vp.sellStrong; baseLw = 2; }
        const lw = Math.max(1, Math.min(4, Math.round(baseLw * vp.lwScalar)));

        const sizeRatio = (parseFloat(m.sizeStr) || 0) / maxSize;
        const sideZh = m.side === 'Buy' ? '买入' : '卖空';
        const labelTitle = m.active ? `${'★'.repeat(m.weight)} ${sideZh} ${m.sizeStr} ${activeCoin}` : '';

        const line = seriesRef.current!.createPriceLine({
          price: m.price,
          color: m.active ? color : 'rgba(0, 0, 0, 0)',
          lineWidth: m.active ? (lw as any) : 1,
          lineStyle: m.active ? (ls as any) : 3,
          axisLabelVisible: m.active,
          axisLabelTextColor: m.active ? vp.labelText : 'rgba(0,0,0,0)',
          title: labelTitle,
        });
        targetLines.push(line);
      });
      return;
    }

    // In-place exact real-time update using applyOptions (0ms redraw)
    const maxSize = Math.max(...matrix.map(m => parseFloat(m.sizeStr) || 0), 0.0001);

    matrix.forEach((m, index) => {
      let baseLw = m.weight >= 3 ? 2 : 1;
      const calculatedLw = Math.max(1, Math.min(4, Math.round(baseLw * vp.lwScalar)));

      const color = m.side === 'Buy' ? (m.weight >= 3 ? vp.buyStrong : vp.buy) : (m.weight >= 3 ? vp.sellStrong : vp.sell);
      const ls = m.weight === 2 ? 2 : (m.weight >= 3 ? 0 : 1);

      const sizeRatio = (parseFloat(m.sizeStr) || 0) / maxSize;
      const pad = ' '.repeat(Math.round(sizeRatio * 24));
      const sideZh = m.side === 'Buy' ? '买入' : '卖空';
      const labelTitle = m.active ? `${'★'.repeat(m.weight)} ${sideZh} ${m.sizeStr} ${activeCoin}${pad}` : '';

      targetLines[index].applyOptions({
        price: m.price,
        title: labelTitle,
        color: m.active ? color : 'rgba(0, 0, 0, 0)',
        axisLabelVisible: m.active,
        axisLabelTextColor: m.active ? vp.labelText : 'rgba(0,0,0,0)',
        lineWidth: m.active ? (calculatedLw as any) : 1,
        lineStyle: m.active ? (ls as any) : 3
      });
    });

  }, [matrix]);


  const intervals = [
    { label: '5M', value: '5m' },
    { label: '15M', value: '15m' },
    { label: '30M', value: '30m' },
    { label: '1H', value: '1h' },
    { label: '2H', value: '2h' },
    { label: '4H', value: '4h' },
    { label: '1D', value: '1d' }
  ];

  return (
    <div className="flex flex-col h-full w-full bg-bg-main text-text-main font-sans transition-colors duration-200">
      <header className="h-14 shrink-0 border-b border-border-subtle flex items-center px-4 justify-between bg-bg-card font-sans z-20 transition-colors duration-200">
        <div className="flex items-center space-x-3 lg:space-x-6">
          <div className="flex items-center space-x-2">
            <span className="font-black text-lg lg:text-xl tracking-widest bg-gradient-to-r from-fib-a to-blue-400 bg-clip-text text-transparent">TIDE</span>
            <span className="text-text-muted font-medium hidden sm:inline text-xs tracking-wider">× HyperLiquid</span>
          </div>
          <div className="h-6 w-px bg-border-subtle hidden sm:block"></div>
          <div className="flex flex-col">
            {/* 交易对下拉选择器 */}
            <div ref={coinDropdownRef} className="relative">
              <button
                onClick={() => { setCoinDropdownOpen(v => !v); setCoinSearch(''); }}
                className="flex items-center gap-1 text-sm lg:text-lg font-bold hover:text-fib-a transition-colors"
              >
                {activeCoin}-PERP
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${coinDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {coinDropdownOpen && (
                <div className="absolute top-full left-0 mt-1 w-52 bg-bg-card border border-border-subtle rounded-md shadow-2xl z-50 overflow-hidden">
                  <input
                    autoFocus
                    value={coinSearch}
                    onChange={e => setCoinSearch(e.target.value)}
                    placeholder="搜索交易对..."
                    className="w-full px-3 py-2 text-xs bg-bg-main border-b border-border-subtle outline-none text-text-main placeholder-text-muted"
                  />
                  <div className="max-h-52 overflow-y-auto custom-scrollbar">
                    {Object.keys(coinMetaMap).length === 0 && (
                      <div className="px-3 py-3 text-xs text-text-muted font-mono">加载中...</div>
                    )}
                    {Object.keys(coinMetaMap)
                      .filter(c => c.toLowerCase().includes(coinSearch.toLowerCase()))
                      .slice(0, 80)
                      .map(coin => (
                        <button
                          key={coin}
                          onClick={() => {
                            setActiveCoin(coin);
                            setCoinDropdownOpen(false);
                            setCoinSearch('');
                            setCurrentPrice(0);
                            setFibGroupA(null);
                            setFibGroupB(null);
                            setManualOrderOverrides({});
                          }}
                          className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors ${coin === activeCoin ? 'text-fib-a font-bold bg-fib-a/10' : 'text-text-main hover:bg-bg-main'}`}
                        >
                          {coin}-PERP {coin === activeCoin && '✓'}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
            <div className="text-[10px] text-text-muted tracking-widest font-mono">
              {currentPrice > 0 && <span className="text-text-main font-bold">${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>}
              {currentPrice > 0 && <span className="hidden sm:inline text-text-muted"> · </span>}
              <span className="hidden sm:inline">{activeInterval.toUpperCase()} · {matrix.filter(m => m.active).length}/{matrix.length} 订单</span>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-3 lg:space-x-6">
          <label className="group flex items-center space-x-2 cursor-pointer select-none">
            <div className="relative flex items-center justify-center">
              <input type="checkbox" checked={showFibA} onChange={() => setShowFibA(!showFibA)} className="sr-only" />
              <div className={`w-3.5 h-3.5 rounded-sm border transition-colors flex items-center justify-center ${showFibA ? 'bg-fib-a border-fib-a' : 'border-text-muted bg-transparent group-hover:border-fib-a'}`}>
                 {showFibA && <Check strokeWidth={3} className="w-2.5 h-2.5 text-white" /> }
              </div>
            </div>
            <span className="text-[10px] lg:text-[11px] font-mono font-medium text-text-muted group-hover:text-text-main transition-colors">{getFibParam()}D 斐波那契</span>
          </label>

          <label className="group flex items-center space-x-2 cursor-pointer select-none">
            <div className="relative flex items-center justify-center">
              <input type="checkbox" checked={showFibB} onChange={() => setShowFibB(!showFibB)} className="sr-only" />
              <div className={`w-3.5 h-3.5 rounded-sm border transition-colors flex items-center justify-center ${showFibB ? 'bg-fib-b border-fib-b' : 'border-text-muted bg-transparent group-hover:border-fib-b'}`}>
                 {showFibB && <Check strokeWidth={3} className="w-2.5 h-2.5 text-white" /> }
              </div>
            </div>
            <span className="text-[10px] lg:text-[11px] font-mono font-medium text-text-muted group-hover:text-text-main transition-colors">4H 斐波那契</span>
          </label>

          <div className="h-4 w-px bg-border-subtle hidden sm:block"></div>

          <button
            onClick={() => setShowGrid(g => !g)}
            className={`p-1.5 rounded-md border transition-colors text-xs font-mono font-bold tracking-widest ${showGrid ? 'border-fib-a text-fib-a bg-fib-a/10' : 'border-border-subtle text-text-muted hover:text-text-main hover:bg-border-subtle'}`}
            title="背景网格线开关"
          >
            网格
          </button>

          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            className="p-1.5 rounded-md border border-border-subtle hover:bg-border-subtle text-text-muted hover:text-text-main transition-colors"
            title="切换亮/暗模式"
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>

          <Link href="/settings" className="p-1.5 rounded-md border border-border-subtle hover:bg-border-subtle text-text-muted hover:text-text-main transition-colors" title="系统设置">
            <SettingsIcon size={15} />
          </Link>
        </div>
      </header>
      
      <div className="bg-bg-card border-b border-border-subtle flex items-center px-4 text-[11px] font-mono text-text-muted z-10 relative transition-colors duration-200 shrink-0">
        {intervals.map((inv) => (
          <button
            key={inv.value}
            onClick={() => setActiveInterval(inv.value)}
            className={`px-4 py-2 cursor-pointer hover:bg-border-subtle/50 transition-colors focus:outline-none ${
              activeInterval === inv.value
                ? 'text-yellow-500 border-b-2 border-yellow-500 font-bold'
                : 'border-b-2 border-transparent hover:text-text-main'
            }`}
          >
            {inv.label}
          </button>
        ))}
      </div>

      {/* Main Content Layout */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left: Chart Area */}
        <main className="flex-1 relative overflow-hidden bg-bg-main h-full transition-colors duration-200">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg-main/80 z-10 text-text-main font-medium tracking-wide">
              <div className="flex items-center space-x-3">
                <svg className="animate-spin h-5 w-5 text-fib-a" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span className="font-mono text-sm tracking-widest uppercase">正在拉取市场数据...</span>
              </div>
            </div>
          )}
          {errorMSG && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg-main/80 z-10 text-kline-down">
              <div className="bg-kline-down/10 p-4 rounded-md border border-kline-down/20 max-w-lg text-center">
                <p className="font-bold mb-1 text-[11px] uppercase tracking-widest text-kline-down">图表加载失败</p>
                <p className="text-sm opacity-80 font-mono text-text-main">{errorMSG}</p>
              </div>
            </div>
          )}
          <div ref={chartContainerRef} className="absolute inset-0" />
        </main>

        {/* Drag Handle */}
        <div 
          className="w-1.5 hover:w-2 bg-transparent hover:bg-fib-a/50 cursor-col-resize z-30 transition-all active:bg-fib-a shrink-0"
          onMouseDown={(e) => {
            isResizingRef.current = true;
            document.body.style.cursor = 'col-resize';
            const handleMouseMove = (moveEvent: MouseEvent) => {
              if (!isResizingRef.current) return;
              const newWidth = document.body.clientWidth - moveEvent.clientX;
              if (newWidth >= 480 && newWidth <= 1100) {
                setSidebarWidth(newWidth);
              }
            };
            const handleMouseUp = () => {
              isResizingRef.current = false;
              document.body.style.cursor = '';
              document.removeEventListener('mousemove', handleMouseMove);
              document.removeEventListener('mouseup', handleMouseUp);
            };
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
          }}
        />

        {/* Right: Strategy Panel */}
        <aside
          style={{ width: `${sidebarWidth}px` }}
          className="shrink-0 bg-bg-card border-l border-border-subtle flex flex-col z-20 transition-colors duration-200 overflow-hidden"
        >
          {/* zoom wrapper - applies to all inner content */}
          <div style={{ zoom: sidebarZoom }} className="flex flex-col flex-1 min-h-0">
          {/* Tab Bar */}
          <div className="shrink-0 flex border-b border-border-subtle bg-bg-card">
            <button
              onClick={() => { setSidebarTab('orders'); }}
              className={`flex-1 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 ${sidebarTab === 'orders' ? 'text-yellow-500 border-b-2 border-yellow-500' : 'text-text-muted hover:text-text-main border-b-2 border-transparent'}`}
            >
              <Zap className="w-4 h-4 fill-current" /> 部署订单
              {matrix.filter(m => m.active).length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-500 text-xs font-bold">{matrix.filter(m => m.active).length}</span>
              )}
            </button>
            <button
              onClick={() => { setSidebarTab('openOrders'); fetchOpenOrders(); }}
              className={`flex-1 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 ${sidebarTab === 'openOrders' ? 'text-fib-a border-b-2 border-fib-a' : 'text-text-muted hover:text-text-main border-b-2 border-transparent'}`}
            >
              <Check className="w-4 h-4" /> 现有订单
              {openOrders.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-fib-a/20 text-fib-a text-xs font-bold">{openOrders.length}</span>
              )}
            </button>
            <button
              onClick={() => setSidebarTab('balance')}
              className={`flex-1 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 ${sidebarTab === 'balance' ? 'text-fib-a border-b-2 border-fib-a' : 'text-text-muted hover:text-text-main border-b-2 border-transparent'}`}
            >
              <DollarSign className="w-4 h-4" /> 余额
            </button>
            <button
              onClick={() => setSidebarTab('params')}
              className={`flex-1 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 ${sidebarTab === 'params' ? 'text-fib-a border-b-2 border-fib-a' : 'text-text-muted hover:text-text-main border-b-2 border-transparent'}`}
            >
              <BarChart className="w-4 h-4" /> 参数
            </button>
          </div>

          {/* Tab: 参数与状态 */}
          {sidebarTab === 'params' && (
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {/* Module A: Status */}
              <div className="p-4 border-b border-border-subtle">
                <h3 className="text-sm font-bold uppercase tracking-wider text-text-muted mb-4 flex items-center"><Wallet className="w-4 h-4 mr-2"/> 全局持仓 (HL Perp)</h3>
                {hlPositions === null ? (
                  <div className="text-sm text-text-muted font-mono animate-pulse">正在连接 HyperLiquid...</div>
                ) : hlPositions.length === 0 ? (
                  <div className="text-sm text-text-main font-mono p-3 bg-bg-main rounded border border-border-subtle">无可用持仓</div>
                ) : (
                  <div className="space-y-2">
                    {hlPositions.map((p: any) => {
                      const szi = parseFloat(p.szi);
                      const pnl = parseFloat(p.unrealizedPnl);
                      const entryPx = parseFloat(p.entryPx);
                      const isLong = szi > 0;
                      const isActive = p.coin === activeCoin;
                      return (
                        <div
                          key={p.coin}
                          className={`space-y-2 p-3 bg-bg-main rounded border ${isActive ? 'border-yellow-500 ring-1 ring-yellow-500/40' : 'border-border-subtle'}`}
                        >
                          <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-bold px-2 py-0.5 rounded ${isLong ? 'bg-kline-up/20 text-kline-up' : 'bg-kline-down/20 text-kline-down'}`}>
                                {isLong ? '做多' : '做空'}
                              </span>
                              <span className="text-sm font-bold text-text-main">{p.coin}</span>
                              {isActive && <span className="text-[10px] font-bold text-yellow-500">● 当前</span>}
                            </div>
                            <span className="font-mono font-bold text-base">{Math.abs(szi)} {p.coin}</span>
                          </div>
                          <div className="flex justify-between text-xs font-mono">
                            <span className="text-text-muted">入场价:</span>
                            <span className="text-text-main">{isNaN(entryPx) ? '—' : entryPx.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between items-center text-sm font-mono pt-2 border-t border-border-subtle/50">
                            <span className="text-text-muted">未实现盈亏:</span>
                            <span className={pnl >= 0 ? 'text-kline-up' : 'text-kline-down'}>
                              {pnl > 0 ? '+' : ''}{isNaN(pnl) ? '—' : pnl.toFixed(2)} USDT
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {hlPositions === null && (
                   <p className="text-xs text-text-muted mt-2">请先在右上角设置中配置 API 以获取链上状态。</p>
                )}
              </div>

              {/* Module B: Config */}
              <div className="p-4">
                <h3 className="text-sm font-bold uppercase tracking-wider text-text-muted mb-4 flex items-center"><BarChart className="w-4 h-4 mr-2"/> 共振参数设置</h3>
                <div className="space-y-4">
                  <div className="flex flex-col space-y-1">
                    <div className="flex justify-between text-sm text-text-muted">
                      <span>杠杆倍数 (Leverage)</span>
                      <span>余额: <span className={accountValue > 0 ? "text-fib-a font-bold" : ""}>{accountValue > 0 ? `$${accountValue.toFixed(2)}` : '未连接/0'}</span></span>
                    </div>
                    <div className="flex space-x-2">
                      <div className="relative w-20 shrink-0">
                        <input
                          type="number" min="1" max="150"
                          value={leverage || ''}
                          onChange={e => setLeverage(Number(e.target.value) || 1)}
                          className="w-full bg-bg-main border border-border-subtle text-text-main font-mono text-base px-2 py-1.5 rounded focus:border-fib-a focus:outline-none"
                        />
                        <span className="absolute right-2 top-1.5 text-text-muted text-xs font-mono">x</span>
                      </div>
                      <button
                        onClick={() => {
                           if (accountValue > 0) {
                             const cap = Math.floor(accountValue * leverage * 0.95);
                             applyNewTotalCapital(cap);
                           } else {
                             if (paramNoticeTimer.current) clearTimeout(paramNoticeTimer.current);
                             setParamNotice('未检测到合约账户余额，请在设置页面配置正确的 Master 地址。');
                             paramNoticeTimer.current = setTimeout(() => setParamNotice(null), 4000);
                           }
                        }}
                        className="flex-1 bg-bg-main border border-border-subtle hover:border-fib-a text-fib-a text-xs rounded transition-colors whitespace-nowrap font-medium"
                      >
                        按余额和杠杆自动演算满仓规模
                      </button>
                    </div>
                    {paramNotice && (
                      <div className="mt-2 px-2 py-1.5 rounded bg-kline-down/10 border border-kline-down/30 text-kline-down text-xs font-mono flex items-start gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        {paramNotice}
                      </div>
                    )}
                  </div>

                  <div>
                     <label className="text-sm text-text-muted block mb-1">网格策略总规模 (USDT, 持仓名义价值)</label>
                     <input
                       type="number"
                       value={totalCapital || ''}
                       onChange={handleCapitalChange}
                       className="w-full bg-bg-main border border-border-subtle text-text-main font-mono text-base px-2 py-1.5 rounded focus:border-fib-a focus:outline-none"
                     />
                     <div className="text-xs text-text-muted mt-1.5 flex justify-between px-1">
                       <span className="opacity-70">分配规模 = 各挂单的法币总和</span>
                       <span>保证金: <span className="text-text-main font-mono">${(totalCapital / (leverage || 1)).toFixed(2)}</span></span>
                     </div>
                  </div>

                  <div className="pt-1">
                     <label className="text-sm text-text-muted block mb-1 flex justify-between">
                        <span>合并容差阈值 (%)</span>
                        <span className="font-mono text-fib-a">{tolerance}%</span>
                     </label>
                     <input type="range" min="0.1" max="2.0" step="0.1" value={tolerance}
                       onChange={e => setTolerance(Number(e.target.value))} className="w-full accent-fib-a" />
                  </div>

                  <div className="pt-1">
                     <label className="text-sm text-text-muted block mb-1 flex justify-between">
                        <span>远端网格递增 (马丁格尔)</span>
                        <span className="font-mono text-fib-a">+{Math.round(depthScale * 100)}%/层</span>
                     </label>
                     <input type="range" min="0" max="2.0" step="0.1" value={depthScale}
                       onChange={e => setDepthScale(Number(e.target.value))} className="w-full accent-fib-a" />
                     <p className="text-xs text-text-muted mt-1 opacity-70">0%=纯星级分配；＞0=远端挂单更多(抗浮亏)</p>
                  </div>
                  <div className="flex justify-between text-xs text-text-muted font-mono pt-1">
                     <span>权重: 1D(2) 4H(1)</span>
                     <span>现价: ${currentPrice.toFixed(0)}</span>
                  </div>
                </div>
              </div>

              {/* Weight Rules */}
              <div className="p-4 border-t border-border-subtle">
                <h3 className="text-sm font-bold uppercase tracking-wider text-text-muted mb-3">星级权重规则</h3>
                <div className="space-y-2">
                  {[
                    { stars: 1, label: '仅 4H 斐波那契位', desc: '4H 单独' },
                    { stars: 2, label: '仅 1D 斐波那契位', desc: '1D 单独' },
                    { stars: 3, label: '1D + 4H 共振', desc: '容差内重叠' },
                    { stars: 4, label: '2×1D + 4H', desc: '日线+4H' },
                    { stars: 5, label: '2×1D + 4H 强共振', desc: '高叠加' },
                  ].map(({ stars, label, desc }) => (
                    <div key={stars} className="flex items-center justify-between text-sm font-mono">
                      <div className="flex items-center gap-2">
                        <span className="text-yellow-500 tracking-tighter">{'★'.repeat(stars)}{'☆'.repeat(Math.max(0, 3 - stars))}</span>
                        <span className="text-text-main">{label}</span>
                      </div>
                      <span className="text-text-muted text-xs">{desc}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-text-muted mt-3 opacity-70 leading-relaxed">
                  星级越高代表斐波那契共振越强，按星级比例分配仓位。
                </p>

                {/* 字号调节 */}
                <div className="mt-4 pt-4 border-t border-border-subtle">
                  <label className="text-sm text-text-muted block mb-1 flex justify-between">
                    <span>界面字号缩放</span>
                    <span className="font-mono text-fib-a">{Math.round(sidebarZoom * 100)}%</span>
                  </label>
                  <input type="range" min="0.7" max="2.0" step="0.05"
                    value={sidebarZoom}
                    onChange={e => setSidebarZoom(parseFloat(e.target.value))}
                    className="w-full accent-fib-a"
                  />
                  <div className="flex justify-between text-xs text-text-muted mt-0.5 px-0.5">
                    <span>70%</span><span>100%</span><span>150%</span><span>200%</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab: 订单矩阵 */}
          {sidebarTab === 'orders' && (
            <>
              <div className="flex-1 flex flex-col overflow-hidden bg-bg-main">
                {/* Header with filter buttons */}
                <div className="px-3 pt-3 pb-2 shrink-0 z-10 bg-bg-main border-b border-border-subtle/50">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center">
                      <Zap className="w-4 h-4 mr-2 text-yellow-500 fill-current"/> 部署订单 (草稿)
                    </h3>
                  </div>
                  {matrix.length > 0 && (
                    <div className="flex items-center flex-wrap gap-1">
                      {([
                        { label: '全选',   fn: () => selectWhere(() => true) },
                        { label: '全不选', fn: () => selectWhere(() => false) },
                        { label: '买单',   fn: () => selectWhere(m => m.side === 'Buy'),  color: 'text-kline-up' },
                        { label: '卖单',   fn: () => selectWhere(m => m.side === 'Sell'), color: 'text-kline-down' },
                        { label: '★',      fn: () => selectWhere(m => m.weight === 1),   color: 'text-yellow-500' },
                        { label: '★★',     fn: () => selectWhere(m => m.weight === 2),   color: 'text-yellow-500' },
                        { label: '★★★',    fn: () => selectWhere(m => m.weight >= 3),    color: 'text-yellow-500' },
                      ] as { label: string; fn: () => void; color?: string }[]).map(({ label, fn, color }) => (
                        <button key={label} onClick={fn}
                          className={`text-xs font-mono border border-border-subtle hover:border-text-muted rounded px-1.5 py-0.5 transition-colors ${color ?? 'text-text-muted hover:text-text-main'}`}
                        >{label}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto p-4 pt-2 custom-scrollbar space-y-2 relative z-0">
                  {matrix.map((m, i) => {
                    const szVal = parseFloat(m.sizeStr) || 0;
                    const lotSize = coinMetaMap[activeCoin] ? Math.pow(10, -coinMetaMap[activeCoin].szDecimals) : 0.001;
                    const belowMin = m.active && szVal < lotSize;
                    return (
                    <div key={i} className={`p-2 rounded-md border transition-colors text-xs font-mono group ${belowMin ? 'bg-kline-down/5 border-kline-down/40' : m.active ? 'bg-bg-card border-border-subtle hover:border-text-muted' : 'bg-bg-main border-border-subtle/30 opacity-50'}`}>
                      <div className="flex justify-between items-center mb-1">
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" checked={m.active} onChange={() => toggleOrderActive(i)}
                            className="rounded border-border-subtle text-fib-a focus:ring-fib-a bg-bg-main w-3.5 h-3.5 cursor-pointer" />
                          {editingPriceIndex === i ? (
                            <input
                              type="text"
                              autoFocus
                              value={priceDraft}
                              onChange={(e) => setPriceDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitOrderPrice(i, priceDraft);
                                else if (e.key === 'Escape') setEditingPriceIndex(-1);
                              }}
                              onBlur={() => commitOrderPrice(i, priceDraft)}
                              className="bg-bg-main border border-fib-a rounded px-1 py-0.5 w-24 outline-none text-sm font-bold font-mono text-text-main"
                            />
                          ) : (
                            <>
                              <span className={`font-bold text-sm ${m.active ? (m.isManualPrice ? 'text-fib-a' : 'text-text-main') : 'text-text-muted line-through'}`}>${m.price.toFixed(1)}</span>
                              <button
                                type="button"
                                onClick={() => { setPriceDraft(m.price.toFixed(1)); setEditingPriceIndex(i); }}
                                title="编辑价格"
                                className="text-text-muted/50 hover:text-fib-a transition-colors opacity-0 group-hover:opacity-100"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              {m.isManualPrice && (
                                <button
                                  type="button"
                                  onClick={() => resetOrderPrice(i)}
                                  title={`恢复默认价 $${m.origPrice.toFixed(1)}`}
                                  className="text-fib-a/70 hover:text-fib-a transition-colors"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-widest ${m.side === 'Buy' ? 'bg-kline-up/20 text-kline-up' : 'bg-kline-down/20 text-kline-down'}`}>{m.side === 'Buy' ? '买入' : '卖出'}</span>
                      </div>
                      <div className={`flex justify-between items-center transition-opacity ${m.active ? 'opacity-80 group-hover:opacity-100' : 'opacity-40 pointer-events-none'}`}>
                        <div className="flex items-center gap-1.5">
                          <span className="text-text-muted">数量:</span>
                          <input type="text" value={m.sizeStr} onChange={(e) => handleOrderSizeChange(i, e.target.value)}
                            className={`bg-bg-main border rounded px-1 py-0.5 w-16 outline-none text-xs font-mono ${belowMin ? 'border-kline-down text-kline-down focus:border-kline-down' : 'border-border-subtle text-text-main focus:border-fib-a'}`} />
                          {belowMin ? (
                            <span className="text-kline-down text-[9px] font-bold">{'<'}0.001</span>
                          ) : szVal > 0 ? (
                            <span className="text-text-muted text-[9px] font-mono">≈${(szVal * m.price).toFixed(0)}</span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1">
                          {m.side === 'Sell' && reduceOnlySells && (
                            <span className="text-[9px] font-bold border border-kline-down/50 text-kline-down rounded px-1 py-0.5 leading-none">R</span>
                          )}
                          <span className="text-yellow-500">{'★'.repeat(m.weight)}</span>
                        </div>
                      </div>
                    </div>
                  );})}
                  {matrix.length === 0 && (
                    <div className="text-text-muted text-xs text-center py-6 font-mono">正在计算订单矩阵...</div>
                  )}
                </div>
              </div>

              <div className="p-4 border-t border-border-subtle bg-bg-card shadow-[0_-10px_20px_rgba(0,0,0,0.2)]">
                 <label className="flex items-center justify-between mb-3 cursor-pointer select-none group">
                   <div className="flex flex-col">
                     <span className="text-xs font-medium text-text-main">卖单只减仓 (Reduce-Only)</span>
                     <span className="text-[10px] text-text-muted font-mono mt-0.5">开启后卖单仅平多仓，不开空</span>
                   </div>
                   <div onClick={() => setReduceOnlySells(v => !v)}
                     className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${reduceOnlySells ? 'bg-fib-a' : 'bg-border-subtle'}`}>
                     <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${reduceOnlySells ? 'translate-x-4' : 'translate-x-0.5'}`} />
                   </div>
                 </label>
                 <button
                   disabled={isDeploying || matrix.filter(m => m.active).length === 0 || matrix.some(m => { const lot = coinMetaMap[activeCoin] ? Math.pow(10, -coinMetaMap[activeCoin].szDecimals) : 0.001; return m.active && (parseFloat(m.sizeStr) || 0) < lot; })}
                   onClick={handleDeployOrders}
                   className={`w-full py-3 rounded-md font-bold transition-colors flex items-center justify-center tracking-wider text-sm
                     ${isDeploying || matrix.filter(m => m.active).length === 0 || matrix.some(m => { const lot = coinMetaMap[activeCoin] ? Math.pow(10, -coinMetaMap[activeCoin].szDecimals) : 0.001; return m.active && (parseFloat(m.sizeStr) || 0) < lot; }) ? 'bg-bg-main text-text-muted border border-border-subtle cursor-not-allowed' : 'bg-fib-a hover:bg-fib-a/90 text-white'}
                   `}>
                    {isDeploying ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Zap className="w-4 h-4 mr-2 fill-current"/>}
                    {isDeploying ? '正在计算 L1 签名并部署...' : '⚡ 一键部署限价单'}
                 </button>
                 {deployResult && (
                   <div className={`mt-3 p-2 rounded text-xs flex items-center font-mono ${deployResult.status === 'success' ? 'bg-kline-up/10 text-kline-up border border-kline-up/20' : 'bg-kline-down/10 text-kline-down border border-kline-down/20'}`}>
                     <AlertCircle className="w-3 h-3 mr-1.5 shrink-0" />{deployResult.msg}
                   </div>
                 )}
                 {!deployResult && (
                   <p className="text-[10px] text-text-muted text-center mt-2 font-mono">私钥仅发送到本机 API 路由用于 HyperLiquid SDK 签名</p>
                 )}
              </div>
            </>
          )}

          {/* Tab: 现有订单 */}
          {sidebarTab === 'openOrders' && (
            <div className="flex-1 flex flex-col overflow-hidden bg-bg-main">
              {/* Header */}
              <div className="px-3 pt-3 pb-2 shrink-0 border-b border-border-subtle/50 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center">
                  <Check className="w-4 h-4 mr-2 text-fib-a"/>
                  现有挂单
                  {openOrders.length > 0 && (() => {
                    const coins = [...new Set(openOrders.map(o => o.coin))];
                    return <span className="ml-1.5 font-mono normal-case text-[10px] opacity-70">({coins.join(' / ')})</span>;
                  })()}
                </h3>
                <div className="flex items-center gap-2">
                  {selectedOrderIds.size > 0 && (
                    <button
                      onClick={() => handleCancelOrders(openOrders.filter(o => selectedOrderIds.has(o.oid)).map(o => ({ oid: o.oid, coin: o.coin })))}
                      disabled={isCanceling}
                      className="text-xs font-bold px-2 py-1 rounded bg-kline-down/20 text-kline-down border border-kline-down/40 hover:bg-kline-down/30 transition-colors disabled:opacity-50"
                    >
                      {isCanceling ? '取消中...' : `取消选中 (${selectedOrderIds.size})`}
                    </button>
                  )}
                  {openOrders.length > 0 && (
                    <button
                      onClick={() => handleCancelOrders(openOrders.map(o => ({ oid: o.oid, coin: o.coin })))}
                      disabled={isCanceling}
                      className="text-xs font-bold px-2 py-1 rounded bg-kline-down/10 text-kline-down border border-kline-down/30 hover:bg-kline-down/20 transition-colors disabled:opacity-50"
                    >
                      {isCanceling ? '...' : '全部取消'}
                    </button>
                  )}
                  <button
                    onClick={fetchOpenOrders}
                    disabled={isFetchingOpenOrders}
                    className="text-xs font-mono border border-border-subtle hover:border-text-muted text-text-muted hover:text-text-main rounded px-2 py-1 transition-colors disabled:opacity-50"
                  >
                    {isFetchingOpenOrders ? '刷新中...' : '↻ 刷新'}
                  </button>
                </div>
              </div>

              {/* Order list */}
              <div className="flex-1 overflow-y-auto p-3 custom-scrollbar space-y-2">
                {isFetchingOpenOrders && openOrders.length === 0 && (
                  <div className="text-text-muted text-xs text-center py-6 font-mono animate-pulse">加载中...</div>
                )}
                {!isFetchingOpenOrders && openOrders.length === 0 && (
                  <div className="text-text-muted text-xs text-center py-6 font-mono">
                    暂无挂单
                    <br /><span className="text-[10px] opacity-60">点击刷新按钮获取最新数据</span>
                  </div>
                )}
                {(() => {
                  // 按 coin 分组
                  const coins = [...new Set(openOrders.map(o => o.coin))];
                  return coins.map(coin => {
                    const coinOrders = openOrders.filter(o => o.coin === coin);
                    return (
                      <div key={coin}>
                        <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted/60 mb-1.5 mt-1 px-0.5">{coin}-PERP</div>
                        <div className="space-y-1.5">
                          {coinOrders.map(order => {
                            const isBuy = order.side === 'B';
                            const isSelected = selectedOrderIds.has(order.oid);
                            const isTrigger = order.orderType && order.orderType !== 'Limit';
                            const usdVal = isTrigger ? null : (parseFloat(order.sz) * parseFloat(order.limitPx)).toFixed(0);
                            return (
                              <div
                                key={order.oid}
                                onClick={() => setSelectedOrderIds(prev => {
                                  const next = new Set(prev);
                                  isSelected ? next.delete(order.oid) : next.add(order.oid);
                                  return next;
                                })}
                                className={`p-2 rounded-md border transition-colors text-xs font-mono cursor-pointer ${isSelected ? 'bg-fib-a/10 border-fib-a/50' : 'bg-bg-card border-border-subtle hover:border-text-muted'}`}
                              >
                                <div className="flex justify-between items-center mb-1">
                                  <div className="flex items-center gap-2">
                                    <input type="checkbox" readOnly checked={isSelected}
                                      className="rounded border-border-subtle text-fib-a bg-bg-main w-3.5 h-3.5 pointer-events-none" />
                                    {isTrigger ? (
                                      <div className="flex flex-col gap-0.5">
                                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-text-muted/10 text-text-muted border border-text-muted/20 self-start">
                                          {order.orderType}
                                        </span>
                                        {order.triggerCondition && (
                                          <span className="text-[9px] text-text-muted/70 font-mono">触发条件：{order.triggerCondition}</span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="font-bold text-sm text-text-main">${parseFloat(order.limitPx).toFixed(1)}</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-widest ${isBuy ? 'bg-kline-up/20 text-kline-up' : 'bg-kline-down/20 text-kline-down'}`}>
                                      {isBuy ? '买入' : '卖出'}
                                    </span>
                                    <button
                                      onClick={e => { e.stopPropagation(); handleCancelOrders([{ oid: order.oid, coin: order.coin }]); }}
                                      disabled={isCanceling}
                                      className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-kline-down/40 text-kline-down hover:bg-kline-down/10 transition-colors disabled:opacity-40"
                                    >取消</button>
                                  </div>
                                </div>
                                <div className="flex justify-between items-center text-text-muted">
                                  <span>
                                    {order.sz} {order.coin}
                                    {usdVal && <span className="text-[9px]"> ≈${usdVal}</span>}
                                  </span>
                                  <span className="text-[9px] opacity-60">{new Date(order.timestamp).toLocaleTimeString('zh-CN')}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>

              {cancelResult && (
                <div className={`mx-3 mb-3 p-2 rounded text-xs flex items-center font-mono ${cancelResult.status === 'success' ? 'bg-kline-up/10 text-kline-up border border-kline-up/20' : 'bg-kline-down/10 text-kline-down border border-kline-down/20'}`}>
                  <AlertCircle className="w-3 h-3 mr-1.5 shrink-0" />{cancelResult.msg}
                </div>
              )}
            </div>
          )}

          {sidebarTab === 'balance' && (
            <div className="flex-1 flex flex-col overflow-hidden bg-bg-main">
              <div className="px-3 pt-3 pb-2 shrink-0 border-b border-border-subtle/50 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center">
                  <DollarSign className="w-4 h-4 mr-2 text-fib-a"/>
                  余额快照
                  <span className="ml-1.5 font-mono normal-case text-[10px] opacity-70">(USDC / 含浮盈 / 每 24h 自动追加)</span>
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (!accountValue || accountValue <= 0) {
                        alert('尚未获取到账户余额，请稍候');
                        return;
                      }
                      const now = Date.now();
                      const history = balanceHistoryRef.current;
                      const last = history[history.length - 1];
                      const ts = last && last.ts >= now ? last.ts + 1 : now;
                      const next = [...history, { ts, value: accountValue }];
                      balanceHistoryRef.current = next;
                      setBalanceHistory(next);
                      try { localStorage.setItem('balanceHistory', JSON.stringify(next)); } catch {}
                    }}
                    className="text-xs font-mono border border-fib-a/50 text-fib-a hover:bg-fib-a/10 rounded px-2 py-1 transition-colors"
                  >
                    立即快照
                  </button>
                  {balanceHistory.length > 0 && (
                    <button
                      onClick={() => {
                        if (!confirm('确认清空所有余额历史？')) return;
                        balanceHistoryRef.current = [];
                        setBalanceHistory([]);
                        try { localStorage.removeItem('balanceHistory'); } catch {}
                      }}
                      className="text-xs font-mono border border-border-subtle hover:border-kline-down text-text-muted hover:text-kline-down rounded px-2 py-1 transition-colors"
                    >
                      清空
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
                {balanceHistory.length === 0 ? (
                  <div className="text-text-muted text-xs text-center py-6 font-mono">
                    暂无记录
                    <br /><span className="text-[10px] opacity-60">首次拉取账户余额后会自动记录一条</span>
                  </div>
                ) : (
                  <table className="w-full text-sm font-mono">
                    <thead>
                      <tr className="text-[10px] font-bold uppercase tracking-widest text-text-muted/70 border-b border-border-subtle/50">
                        <th className="text-left py-1.5 pl-1">日期</th>
                        <th className="text-right py-1.5">余额 (USDC)</th>
                        <th className="text-right py-1.5">Δ %</th>
                        <th className="py-1.5 pr-1 w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...balanceHistory].reverse().map((entry, idx, arr) => {
                        const prev = arr[idx + 1];
                        const pct = prev ? ((entry.value - prev.value) / prev.value) * 100 : null;
                        const d = new Date(entry.ts);
                        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                        return (
                          <tr key={entry.ts} className="border-b border-border-subtle/30 hover:bg-bg-card/40 group">
                            <td className="text-left py-2 pl-1 text-text-main">{dateStr}</td>
                            <td className="text-right py-2 text-text-main">{entry.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td className={`text-right py-2 ${pct === null ? 'text-text-muted' : pct >= 0 ? 'text-kline-up' : 'text-kline-down'}`}>
                              {pct === null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}
                            </td>
                            <td className="py-2 pr-1 text-right">
                              <button
                                onClick={() => {
                                  const next = balanceHistoryRef.current.filter(e => e.ts !== entry.ts);
                                  balanceHistoryRef.current = next;
                                  setBalanceHistory(next);
                                  try {
                                    if (next.length === 0) localStorage.removeItem('balanceHistory');
                                    else localStorage.setItem('balanceHistory', JSON.stringify(next));
                                  } catch {}
                                }}
                                title="删除该条记录"
                                className="text-text-muted/40 hover:text-kline-down text-xs opacity-0 group-hover:opacity-100 transition-opacity px-1"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          </div>{/* end zoom wrapper */}
        </aside>
      </div>
    </div>
  );
}
