// K 線圖(TradingView Lightweight Charts v4.2.3,Apache 2.0)。紅漲綠跌、台北時間、盲測時不顯示日期。
/* global LightweightCharts */
const UP = '#ff4d4f', DN = '#1fbf75', UPV = 'rgba(255,77,79,.45)', DNV = 'rgba(31,191,117,.45)';
const pad = n => String(n).padStart(2, '0');
function tstr(sec) { const d = new Date(sec * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
function dstr(sec) { const d = new Date(sec * 1000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; }

export class ArenaChart {
  constructor(el, { blind = false, offset = 0, height = null } = {}) {
    this.el = el; this.blind = blind; this.off = offset;
    this.compact = matchMedia('(max-width: 760px)').matches;   // 手機:圖上不寫字(會擋到 K 棒),只留箭頭、顏色和右邊價格標籤
    this.chart = LightweightCharts.createChart(el, {
      autoSize: true,
      height: height || undefined,
      layout: { background: { type: 'solid', color: '#0d1016' }, textColor: '#98a2b3', fontSize: 12,
        fontFamily: '"Segoe UI","Microsoft JhengHei UI","Microsoft JhengHei",sans-serif' },
      grid: { vertLines: { color: 'rgba(42,50,66,.45)' }, horzLines: { color: 'rgba(42,50,66,.45)' } },
      rightPriceScale: { borderColor: '#2a3242', scaleMargins: { top: 0.08, bottom: 0.2 } },
      timeScale: {
        borderColor: '#2a3242', timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 6, minBarSpacing: 0.5,
        tickMarkFormatter: (time, type) => (!blind && type <= 2 ? dstr(time) : tstr(time)),
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      localization: { timeFormatter: t => (blind ? tstr(t) : `${dstr(t)} ${tstr(t)}`), priceFormatter: p => Math.round(p).toLocaleString('en-US') },
    });
    this.candles = this.chart.addCandlestickSeries({
      upColor: UP, downColor: DN, borderUpColor: UP, borderDownColor: DN, wickUpColor: UP, wickDownColor: DN,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    this.vol = this.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
    this.lines = new Map();
    this.markers = [];
  }

  setBars(bars) {
    this.candles.setData(bars);
    this.vol.setData(bars.map(b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? UPV : DNV })));
  }
  update(b) {
    this.candles.update(b);
    this.vol.update({ time: b.time, value: b.volume, color: b.close >= b.open ? UPV : DNV });
  }
  setMarkers(ms) {
    this.markers = [...ms].sort((a, b) => a.time - b.time);
    if (this.compact) this.markers = this.markers.map(m => ({ ...m, text: '', size: m.shape === 'circle' ? 0.35 : 0.5 }));
    this.candles.setMarkers(this.markers);
  }
  // 價格線(委託、均價、停損停利):price 是實際價格,畫面加上平移
  setLine(key, price, { color = '#4f8cff', title = '', style = 2, width = 1 } = {}) {
    const opt = { price: price + this.off, color, title: this.compact ? '' : title, lineStyle: style, lineWidth: width, axisLabelVisible: true };
    const old = this.lines.get(key);
    if (old) old.applyOptions(opt);
    else this.lines.set(key, this.candles.createPriceLine(opt));
  }
  removeLine(key) { const l = this.lines.get(key); if (l) { this.candles.removePriceLine(l); this.lines.delete(key); } }
  syncLines(want) {                                 // want: Map key → {price, opt}
    for (const k of [...this.lines.keys()]) if (!want.has(k)) this.removeLine(k);
    for (const [k, v] of want) this.setLine(k, v.price, v.opt);
  }
  priceAtY(y) { const p = this.candles.coordinateToPrice(y); return p == null ? null : Math.round(p) - this.off; }
  yOfPrice(price) { return this.candles.priceToCoordinate(price + this.off); }
  onClick(fn) { this.chart.subscribeClick(param => { if (param.point) fn(this.priceAtY(param.point.y), param); }); }
  fit() { this.chart.timeScale().fitContent(); }
  toRight() { this.chart.timeScale().scrollToRealTime(); }
  showRecent(nBars) {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    const data = this.candles.data ? this.candles.data() : null;
    const len = data ? data.length : null;
    if (len) ts.setVisibleLogicalRange({ from: Math.max(0, len - nBars), to: len + 6 });
    else if (r) ts.scrollToRealTime();
  }
  setInteractive(on) { this.chart.applyOptions({ handleScroll: on, handleScale: on }); }
  remove() { try { this.chart.remove(); } catch (e) { /* 已經移除 */ } }
}

// 權益曲線(結算畫面):points = [[epochMs, equity], ...]
export function equityChart(el, points, base, blind) {
  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#98a2b3', fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(42,50,66,.45)' } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, tickMarkFormatter: t => tstr(t) },
    localization: { timeFormatter: t => (blind ? tstr(t) : `${dstr(t)} ${tstr(t)}`), priceFormatter: p => Math.round(p).toLocaleString('en-US') },
    handleScroll: false, handleScale: false,
  });
  const s = chart.addBaselineSeries({
    baseValue: { type: 'price', price: base }, topLineColor: UP, bottomLineColor: DN,
    topFillColor1: 'rgba(255,77,79,.25)', topFillColor2: 'rgba(255,77,79,.02)', bottomFillColor1: 'rgba(31,191,117,.02)', bottomFillColor2: 'rgba(31,191,117,.25)',
    priceFormat: { type: 'price', precision: 0, minMove: 1 },
  });
  const seen = new Set();
  const data = [];
  for (const [t, v] of points) {
    const sec = Math.floor(t / 1000) + 8 * 3600;
    if (seen.has(sec)) { data[data.length - 1].value = v; continue; }
    seen.add(sec);
    data.push({ time: sec, value: v });
  }
  s.setData(data);
  chart.timeScale().fitContent();
  return chart;
}
