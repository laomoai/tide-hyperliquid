'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, IChartApi, IPriceLine, ISeriesApi, Time, CandlestickSeries, LineSeries } from 'lightweight-charts';
import { Sun, Moon, Check, Zap, Wallet, BarChart, Settings as SettingsIcon, AlertCircle, Loader2 } from 'lucide-react';
import Link from 'next/link';

type HLCandle = { t: number; T: number; s: string; i: string; o: string; h: string; l: string; c: string; v: string; n: number; };

const HL_API = 'https://api.hyperliquid.xyz/info';
const INTERVAL_MS: Record<string, number> = {
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000,
};

function getPerpAccountValue(data: any): number {
  return parseFloat(data?.marginSummary?.accountValue) || 0;
}

async function fetchHLCandles(interval: string, startTime: number, endTime?: number): Promise<HLCandle[]> {
  const req: any = { coin: 'BTC', interval, startTime };
  if (endTime) req.endTime = endTime;
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req }),
  });
  if (!res.ok) throw new Error(`HyperLiquid ${interval} K线拉取失败`);
  return res.json();
}

async function fetch2200Candles(interval: string): Promise<HLCandle[]> {
  const ms = INTERVAL_MS[interval] ?? INTERVAL_MS['1h'];
  return fetchHLCandles(interval, Date.now() - 2200 * ms);
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
  const [hlPosition, setHlPosition] = useState<any>(null);
  const [tolerance, setTolerance] = useState<number>(0.5);
  const [depthScale, setDepthScale] = useState<number>(0.2);
  const [totalCapital, setTotalCapital] = useState<number>(1000);
  const [leverage, setLeverage] = useState<number>(10);
  const [accountValue, setAccountValue] = useState<number>(0);
  const [manualOrderOverrides, setManualOrderOverrides] = useState<Record<string, { active?: boolean; sizeStr?: string; isManual?: boolean }>>({});

  const [sidebarWidth, setSidebarWidth] = useState(420);
  const [sidebarTab, setSidebarTab] = useState<'params' | 'orders'>('orders');
  const isResizingRef = useRef(false);

  const [isDeploying, setIsDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{status: 'success' | 'err', msg: string} | null>(null);
  const [paramNotice, setParamNotice] = useState<string | null>(null);
  const paramNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const orderKey = (price: number) => price.toFixed(8);

  const generatedMatrix = useMemo(() => {
    if (currentPrice <= 0) return [];
    const input1D = showFibA && fibGroupA ? fibGroupA : [];
    const input4H = showFibB && fibGroupB ? fibGroupB : [];
    return generateMatrix(input1D, input4H, currentPrice, tolerance, totalCapital, depthScale);
  }, [fibGroupA, fibGroupB, showFibA, showFibB, currentPrice, tolerance, totalCapital, depthScale]);

  const matrix = useMemo(() => {
    return generatedMatrix.map((gen) => {
      const existing = manualOrderOverrides[orderKey(gen.price)];
      if (!existing) return gen;
      return {
        ...gen,
        active: existing.active ?? gen.active,
        sizeStr: existing.isManual ? (existing.sizeStr ?? gen.sizeStr) : gen.sizeStr,
        isManual: Boolean(existing.isManual),
      };
    });
  }, [generatedMatrix, manualOrderOverrides]);

  const allActive = matrix.length > 0 && matrix.every(m => m.active);

  const selectWhere = (predicate: (m: typeof matrix[0]) => boolean) => {
    setManualOrderOverrides(prev => {
      const updated = { ...prev };
      matrix.forEach(m => {
        updated[orderKey(m.price)] = { ...prev[orderKey(m.price)], active: predicate(m) };
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
    setManualOrderOverrides((prev) => ({
      ...prev,
      [orderKey(order.price)]: {
        ...prev[orderKey(order.price)],
        active: !order.active,
      },
    }));
  };

  const handleOrderSizeChange = (index: number, newSize: string) => {
    const order = matrix[index];
    if (!order) return;

    const newMatrix = matrix.map((m, i) => i === index ? { ...m, sizeStr: newSize, isManual: true } : m);
    setManualOrderOverrides((prev) => ({
      ...prev,
      [orderKey(order.price)]: {
        ...prev[orderKey(order.price)],
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
      // 2. Format Orders payload natively for Hyperliquid SDK
      // BTC-PERP: tick size = $1 (price integer), lot size = 0.001 BTC (3 decimal places), min sz = 0.001
      const BTC_LOT = 0.001;
      const bulkOrders = activeOrders
        .map(m => {
          const isBuy = m.side === 'Buy';
          const rawSz = parseFloat(m.sizeStr) || 0;
          const sz = Math.floor(rawSz / BTC_LOT) * BTC_LOT;
          const px = Math.round(m.price);
          return { coin: 'BTC-PERP', is_buy: isBuy, sz, limit_px: px, order_type: { limit: { tif: 'Gtc' } }, reduce_only: false };
        })
        .filter(o => o.sz >= BTC_LOT);

      if (bulkOrders.length === 0) {
        setDeployResult({ status: 'err', msg: '所有订单数量均低于最小下单量 0.001 BTC，请调大总规模或减少网格数量' });
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
        body: JSON.stringify({ privateKey: pk, masterAddress, orders: bulkOrders })
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

  // Fetch HL master spot balance and BTC-PERP position
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

        const btcPos = perpData?.assetPositions?.find((p: any) => p.position.coin === 'BTC');
        if (btcPos) {
          setHlPosition(btcPos.position);
        } else {
          setHlPosition('empty');
        }
      } catch (e) {
        console.error("HL Fetch Error", e);
      }
    };
    fetchPos();
    const interval = setInterval(fetchPos, 10000); // Poll every 10s
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
          fetch2200Candles(activeInterval),
          fetchHLCandles('1d', now - fibParam * INTERVAL_MS['1d']),
          fetchHLCandles('4h', now - fibParam * INTERVAL_MS['4h']),
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
        subscription: { type: 'candle', coin: 'BTC', interval: activeInterval },
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
            subscription: { type: 'candle', coin: 'BTC', interval: activeInterval },
          }));
        }
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [activeInterval]);

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
        const labelTitle = m.active ? `${'★'.repeat(m.weight)} ${sideZh} ${m.sizeStr} BTC` : '';

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
      const labelTitle = m.active ? `${'★'.repeat(m.weight)} ${sideZh} ${m.sizeStr} BTC${pad}` : '';

      targetLines[index].applyOptions({
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
            <div className="flex items-center space-x-2">
              <span className="text-sm lg:text-lg font-bold">BTC-PERP</span>
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
              if (newWidth >= 360 && newWidth <= 900) {
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
          {/* Tab Bar */}
          <div className="shrink-0 flex border-b border-border-subtle bg-bg-card">
            <button
              onClick={() => setSidebarTab('params')}
              className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 ${sidebarTab === 'params' ? 'text-fib-a border-b-2 border-fib-a' : 'text-text-muted hover:text-text-main border-b-2 border-transparent'}`}
            >
              <BarChart className="w-3.5 h-3.5" /> 参数与状态
            </button>
            <button
              onClick={() => setSidebarTab('orders')}
              className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 ${sidebarTab === 'orders' ? 'text-yellow-500 border-b-2 border-yellow-500' : 'text-text-muted hover:text-text-main border-b-2 border-transparent'}`}
            >
              <Zap className="w-3.5 h-3.5 fill-current" /> 订单矩阵
              {matrix.filter(m => m.active).length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-500 text-[9px] font-bold">{matrix.filter(m => m.active).length}</span>
              )}
            </button>
          </div>

          {/* Tab: 参数与状态 */}
          {sidebarTab === 'params' && (
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {/* Module A: Status */}
              <div className="p-4 border-b border-border-subtle">
                <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-4 flex items-center"><Wallet className="w-4 h-4 mr-2"/> 全局状态 (HL BTC-PERP)</h3>
                {!hlPosition && hlPosition !== 'empty' ? (
                  <div className="text-sm text-text-muted font-mono animate-pulse">正在连接 HyperLiquid...</div>
                ) : hlPosition === 'empty' ? (
                  <div className="text-sm text-text-main font-mono p-3 bg-bg-main rounded border border-border-subtle">
                    无可用持仓
                  </div>
                ) : (
                  <div className="space-y-2 p-3 bg-bg-main rounded border border-border-subtle">
                    <div className="flex justify-between items-center">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${parseFloat(hlPosition.szi) > 0 ? 'bg-kline-up/20 text-kline-up' : 'bg-kline-down/20 text-kline-down'}`}>
                        {parseFloat(hlPosition.szi) > 0 ? '做多' : '做空'}
                      </span>
                      <span className="font-mono font-bold">{Math.abs(parseFloat(hlPosition.szi))} BTC</span>
                    </div>
                    <div className="flex justify-between items-center text-sm font-mono pt-2 border-t border-border-subtle/50">
                      <span className="text-text-muted text-[11px]">未实现盈亏:</span>
                      <span className={parseFloat(hlPosition.unrealizedPnl) >= 0 ? 'text-kline-up' : 'text-kline-down'}>
                        {parseFloat(hlPosition.unrealizedPnl) > 0 ? '+' : ''}{parseFloat(hlPosition.unrealizedPnl).toFixed(2)} USDT
                      </span>
                    </div>
                  </div>
                )}
                {!hlPosition && (
                   <p className="text-[10px] text-text-muted mt-2">请先在右上角设置中配置 API 以获取链上状态。</p>
                )}
              </div>

              {/* Module B: Config */}
              <div className="p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-4 flex items-center"><BarChart className="w-4 h-4 mr-2"/> 共振参数设置</h3>
                <div className="space-y-4">
                  <div className="flex flex-col space-y-1">
                    <div className="flex justify-between text-[11px] text-text-muted">
                      <span>杠杆倍数 (Leverage)</span>
                      <span>Master USDC: <span className={accountValue > 0 ? "text-fib-a font-bold" : ""}>{accountValue > 0 ? `$${accountValue.toFixed(2)}` : '未连接/0'}</span></span>
                    </div>
                    <div className="flex space-x-2">
                      <div className="relative w-20 shrink-0">
                        <input
                          type="number" min="1" max="150"
                          value={leverage || ''}
                          onChange={e => setLeverage(Number(e.target.value) || 1)}
                          className="w-full bg-bg-main border border-border-subtle text-text-main font-mono text-sm px-2 py-1.5 rounded focus:border-fib-a focus:outline-none"
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
                      <div className="mt-2 px-2 py-1.5 rounded bg-kline-down/10 border border-kline-down/30 text-kline-down text-[10px] font-mono flex items-start gap-1.5">
                        <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                        {paramNotice}
                      </div>
                    )}
                  </div>

                  <div>
                     <label className="text-[11px] text-text-muted block mb-1">网格策略总规模 (USDT, 持仓名义价值)</label>
                     <input
                       type="number"
                       value={totalCapital || ''}
                       onChange={handleCapitalChange}
                       className="w-full bg-bg-main border border-border-subtle text-text-main font-mono text-sm px-2 py-1.5 rounded focus:border-fib-a focus:outline-none"
                     />
                     <div className="text-[10px] text-text-muted mt-1.5 flex justify-between px-1">
                       <span className="opacity-70">分配规模 = 各挂单的法币总和</span>
                       <span>约耗保证金: <span className="text-text-main font-mono">${(totalCapital / (leverage || 1)).toFixed(2)}</span></span>
                     </div>
                  </div>

                  <div className="pt-2">
                     <label className="text-[11px] text-text-muted block mb-1 flex justify-between">
                        <span>合并容差阈值 (%)</span>
                        <span className="font-mono text-fib-a">{tolerance}%</span>
                     </label>
                     <input
                       type="range"
                       min="0.1" max="2.0" step="0.1"
                       value={tolerance}
                       onChange={e => setTolerance(Number(e.target.value))}
                       className="w-full accent-fib-a"
                     />
                  </div>

                  <div className="pt-1">
                     <label className="text-[11px] text-text-muted block mb-1 flex justify-between">
                        <span>远端网格数量递增 (马丁格尔乘数)</span>
                        <span className="font-mono text-fib-a">+{depthScale * 100}%/层</span>
                     </label>
                     <input
                       type="range"
                       min="0" max="2.0" step="0.1"
                       value={depthScale}
                       onChange={e => setDepthScale(Number(e.target.value))}
                       className="w-full accent-fib-a"
                     />
                     <p className="text-[10px] text-text-muted mt-1 opacity-70">
                       0%表示纯按星级分配数量。＞0表示离现价越远的网格，挂单数量翻倍越多(用于抗浮亏)。
                     </p>
                  </div>
                  <div className="flex justify-between text-[11px] text-text-muted font-mono pt-1">
                     <span>权重设置: 1D(2) 4H(1)</span>
                     <span>现价: ${currentPrice.toFixed(0)}</span>
                  </div>
                </div>
              </div>

              {/* Weight Rules */}
              <div className="p-4 border-t border-border-subtle">
                <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-3">星级权重规则</h3>
                <div className="space-y-2">
                  {[
                    { stars: 1, label: '仅 4H 斐波那契位', desc: '4H 单独出现' },
                    { stars: 2, label: '仅 1D 斐波那契位', desc: '1D 单独出现' },
                    { stars: 3, label: '1D + 4H 共振', desc: '两者在容差内重叠' },
                    { stars: 4, label: '2×1D + 4H', desc: '两条日线 + 一条4H' },
                    { stars: 5, label: '2×1D + 4H 强共振', desc: '更高叠加层数' },
                  ].map(({ stars, label, desc }) => (
                    <div key={stars} className="flex items-center justify-between text-[11px] font-mono">
                      <div className="flex items-center gap-2">
                        <span className="text-yellow-500 tracking-tighter">{'★'.repeat(stars)}{'☆'.repeat(Math.max(0, 3 - stars))}</span>
                        <span className="text-text-main">{label}</span>
                      </div>
                      <span className="text-text-muted text-[10px]">{desc}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-text-muted mt-3 opacity-70 leading-relaxed">
                  星级越高代表斐波那契共振越强，系统会按星级比例分配更多仓位。马丁格尔乘数在星级基础上额外叠加远端权重。
                </p>
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
                      <Zap className="w-4 h-4 mr-2 text-yellow-500 fill-current"/> 订单矩阵 (草稿)
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
                        <button
                          key={label}
                          onClick={fn}
                          className={`text-[10px] font-mono border border-border-subtle hover:border-text-muted rounded px-1.5 py-0.5 transition-colors ${color ?? 'text-text-muted hover:text-text-main'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto p-4 pt-2 custom-scrollbar space-y-2 relative z-0">
                  {matrix.map((m, i) => {
                    const szVal = parseFloat(m.sizeStr) || 0;
                    const belowMin = m.active && szVal < 0.001;
                    return (
                    <div key={i} className={`p-2 rounded-md border transition-colors text-xs font-mono group ${belowMin ? 'bg-kline-down/5 border-kline-down/40' : m.active ? 'bg-bg-card border-border-subtle hover:border-text-muted' : 'bg-bg-main border-border-subtle/30 opacity-50'}`}>
                      <div className="flex justify-between items-center mb-1">
                        <label className="flex items-center space-x-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={m.active}
                            onChange={() => toggleOrderActive(i)}
                            className="rounded border-border-subtle text-fib-a focus:ring-fib-a bg-bg-main w-3.5 h-3.5"
                          />
                          <span className={`font-bold ${m.active ? 'text-text-main' : 'text-text-muted line-through'}`}>${m.price.toFixed(1)}</span>
                        </label>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-widest ${m.side === 'Buy' ? 'bg-kline-up/20 text-kline-up' : 'bg-kline-down/20 text-kline-down'}`}>{m.side === 'Buy' ? '买入' : '卖出'}</span>
                      </div>
                      <div className={`flex justify-between items-center transition-opacity ${m.active ? 'opacity-80 group-hover:opacity-100' : 'opacity-40 pointer-events-none'}`}>
                        <div className="flex items-center gap-1.5">
                          <span className="text-text-muted mr-1">数量(BTC):</span>
                          <input
                            type="text"
                            value={m.sizeStr}
                            onChange={(e) => handleOrderSizeChange(i, e.target.value)}
                            className={`bg-bg-main border rounded px-1 py-0.5 w-16 outline-none text-xs font-mono ${belowMin ? 'border-kline-down text-kline-down focus:border-kline-down' : 'border-border-subtle text-text-main focus:border-fib-a'}`}
                          />
                          {belowMin && <span className="text-kline-down text-[9px] font-bold">{'<'}0.001</span>}
                        </div>
                        <span className="text-yellow-500 flex items-center space-x-0.5">
                          {Array.from({length: m.weight}).map((_,j) => <span key={j}>★</span>)}
                        </span>
                      </div>
                    </div>
                  );})}
                  {matrix.length === 0 && (
                    <div className="text-text-muted text-xs text-center py-6 font-mono">
                      正在计算订单矩阵...
                    </div>
                  )}
                </div>
              </div>

              <div className="p-4 border-t border-border-subtle bg-bg-card shadow-[0_-10px_20px_rgba(0,0,0,0.2)]">
                 <button
                   disabled={isDeploying || matrix.filter(m => m.active).length === 0 || matrix.some(m => m.active && (parseFloat(m.sizeStr) || 0) < 0.001)}
                   onClick={handleDeployOrders}
                   className={`w-full py-3 rounded-md font-bold transition-colors flex items-center justify-center tracking-wider text-sm
                     ${isDeploying || matrix.filter(m => m.active).length === 0 || matrix.some(m => m.active && (parseFloat(m.sizeStr) || 0) < 0.001) ? 'bg-bg-main text-text-muted border border-border-subtle cursor-not-allowed' : 'bg-fib-a hover:bg-fib-a/90 text-white'}
                   `}>
                    {isDeploying ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Zap className="w-4 h-4 mr-2 fill-current"/>}
                    {isDeploying ? '正在计算 L1 签名并部署...' : '⚡ 一键部署限价单'}
                 </button>

                 {deployResult && (
                   <div className={`mt-3 p-2 rounded text-xs flex items-center font-mono ${deployResult.status === 'success' ? 'bg-kline-up/10 text-kline-up border border-kline-up/20' : 'bg-kline-down/10 text-kline-down border border-kline-down/20'}`}>
                     <AlertCircle className="w-3 h-3 mr-1.5 shrink-0" />
                     {deployResult.msg}
                   </div>
                 )}

                 {!deployResult && (
                   <p className="text-[10px] text-text-muted text-center mt-2 font-mono">
                     私钥仅发送到本机 API 路由用于 HyperLiquid SDK 签名
                   </p>
                 )}
              </div>
            </>
          )}

        </aside>
      </div>
    </div>
  );
}
