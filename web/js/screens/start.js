// 開局:選賽制(正式賽／情境關卡／練習場)→ 向伺服器要一局 → 進比賽畫面;電腦隨機猴子批次下場
import { api } from '../api.js';
import { modal, toast } from '../ui.js';
import { esc, md, weekday, KIND } from '../util.js';
import { invalidate } from '../state.js';
import { loadGameData, Game } from '../game.js';
import { playMonkey } from '../monkey.js';

const FMT = [
  { k: 'quick', name: '快速局', d: '5 分鐘走完一個日盤＋夜盤(1,140 根 1 分 K)', hot: true },
  { k: 'hour', name: '一小時局', d: '隨機一小時,倍速自己調' },
  { k: 'session', name: '整盤', d: '一整個日盤(5 小時)或夜盤(14 小時)' },
];
const SCEN = [
  { k: '跳空盤', d: '日盤開盤跳空 300 點以上' },
  { k: '大波動盤', d: '一盤高低差 1,000 點以上' },
  { k: '趨勢盤', d: '收盤和開盤差超過高低差 6 成' },
  { k: '盤整盤', d: '收盤和開盤差不到高低差 2 成' },
  { k: '結算日', d: '月選擇權與期貨結算當天' },
];

export async function startGame(c, mode, format, scenario = null, pick = null) {
  try {
    const r = await api.post('/api/game', { cid: c.id, mode, format, scenario, pick });
    invalidate();
    location.hash = '#/play/' + r.game_id;
    return true;
  } catch (e) {
    toast(e.message, 'warn', 4000);
    return false;
  }
}

export async function startFlow(c) {
  if (c.kind === 'monkey') return monkeyFlow(c);
  let av;
  try { av = await api.get('/api/available/' + c.id); } catch (e) { toast(e.message, 'bad'); return; }
  const tile = (attrs, name, d, left, total, hot) => {
    const off = left === 0;
    return `<button class="tile ${off ? 'off' : ''} ${hot ? 'hot' : ''}" ${attrs} ${off ? 'disabled' : ''}>
      <b>${esc(name)}</b><span class="d">${esc(d)}</span><span class="c">${left == null ? '' : `還有 ${left} 局${total != null ? ` / ${total}` : ''}`}</span></button>`;
  };
  const body = `<div class="modes">
    <h4>正式賽(計入戰績,隨機抽一段你沒看過的行情,不顯示日期,不能倒帶)</h4>
    <div class="tiles">${FMT.map(f => tile(`data-fmt="${f.k}"`, f.name, f.d, av[f.k].left, av[f.k].total, f.hot)).join('')}</div>
    <h4>情境關卡(計入戰績,另外分組統計;整盤)</h4>
    <div class="tiles">${SCEN.map(s => tile(`data-scen="${s.k}"`, s.k, s.d, av[s.k].left, av[s.k].total)).join('')}</div>
    <h4>練習場(自己挑日期,可以倒帶,不計入戰績;挑過的行情就不會再出現在正式賽)</h4>
    <div class="row" style="margin-bottom:8px">
      <div class="seg" id="pfmt"><button data-f="quick" class="on">快速局</button><button data-f="session">整盤</button><button data-f="hour">一小時局</button></div>
      <span class="note">灰色 = 已經看過</span>
    </div>
    <div class="plist" id="plist"><div class="note" style="padding:10px">載入中…</div></div>
  </div>`;
  let plist = null;
  await modal({
    title: `${c.name}:選擇賽制`, body, wide: true, buttons: [{ label: '取消', value: null }],
    onMount: async (wrap, close) => {
      wrap.querySelectorAll('[data-fmt]').forEach(b => b.onclick = async () => { close(null); await startGame(c, 'ranked', b.dataset.fmt); });
      wrap.querySelectorAll('[data-scen]').forEach(b => b.onclick = async () => { close(null); await startGame(c, 'scenario', 'session', b.dataset.scen); });
      const box = wrap.querySelector('#plist');
      const draw = f => {
        const items = (plist && plist[f]) || [];
        if (!items.length) { box.innerHTML = '<div class="note" style="padding:10px">沒有資料</div>'; return; }
        box.innerHTML = [...items].reverse().map(it => `<div class="it ${it.seen ? 'dim' : ''}" data-key="${esc(it.key)}">
          <span class="mono">${esc(it.date)}</span><span>(${weekday(it.date)})</span><span>${esc(it.label)}</span>
          <span class="spacer"></span>${it.seen ? '<span class="pill">看過</span>' : ''}</div>`).join('');
        box.querySelectorAll('.it').forEach(el => el.onclick = async () => {
          close(null);
          await startGame(c, 'practice', f, null, { key: el.dataset.key });
        });
      };
      wrap.querySelectorAll('#pfmt button').forEach(b => b.onclick = () => {
        wrap.querySelectorAll('#pfmt button').forEach(x => x.classList.toggle('on', x === b));
        draw(b.dataset.f);
      });
      try { plist = await api.get('/api/practice/' + c.product); draw('quick'); } catch (e) { box.innerHTML = `<div class="note">${esc(e.message)}</div>`; }
    },
  });
}

// 電腦隨機猴子:一次跑很多局(和真人同一個撮合引擎,不記「看過」)
export async function monkeyFlow(c, onDone) {
  const av = await api.get('/api/available/' + c.id).catch(() => null);
  const body = `<div class="form">
    <label>賽制</label><div class="seg" id="mf"><button data-f="quick" class="on">快速局</button><button data-f="hour">一小時局</button><button data-f="session">整盤</button></div>
    <label>局數</label><div class="row"><input type="number" id="mn" min="1" max="300" value="20"><span class="note" id="mleft"></span></div>
    <div class="full note">猴子每局的行為照參賽者設定:每局 ${c.monkey.trades || 5} 筆、平均持有 ${c.monkey.holdMin || 15} 分鐘、${c.monkey.qty || 1} 口${c.monkey.sl ? `、停損 ${c.monkey.sl} 點` : ''}${c.monkey.tp ? `、停利 ${c.monkey.tp} 點` : ''}。
    先抽它還沒玩過的行情,都玩過了才重複。</div>
    <div class="full" id="mprog"></div>
  </div>`;
  let fmt = 'quick';
  const res = await modal({
    title: `${c.name}:下場比賽`, body,
    buttons: [{ label: '取消', value: null }, { label: '開始', kind: 'primary', collect: w => ({ fmt, n: +w.querySelector('#mn').value || 1 }) }],
    onMount: w => {
      const upd = () => { if (av) w.querySelector('#mleft').textContent = `沒玩過的還有 ${av[fmt].left} 局(共 ${av[fmt].total})`; };
      w.querySelectorAll('#mf button').forEach(b => b.onclick = () => {
        fmt = b.dataset.f;
        w.querySelectorAll('#mf button').forEach(x => x.classList.toggle('on', x === b));
        upd();
      });
      upd();
    },
  });
  if (!res) return;
  await runMonkeyBatch(c, res.fmt, res.n);
  if (onDone) onDone();
}

export async function runMonkeyBatch(c, fmt, n) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal"><div class="modal-head"><h3>${esc(c.name)} 比賽中…</h3></div>
    <div class="modal-body"><div class="bar"><i id="mpb" style="width:0"></i></div><p class="note" id="mpt">準備中</p></div></div>`;
  document.getElementById('modal-root').appendChild(wrap);
  const pb = wrap.querySelector('#mpb'), pt = wrap.querySelector('#mpt');
  let plan;
  try { plan = await api.post('/api/monkey/plan', { cid: c.id, format: fmt, count: n }); } catch (e) { wrap.remove(); toast(e.message, 'bad'); return; }
  let done = 0, total = 0;
  for (const it of plan) {
    try {
      const bins = await loadGameData(it.spec);
      const game = new Game(it.spec, c, bins);
      const res = playMonkey(game, c.monkey || {}, it.spec.seed);
      total += res.summary.pnl;
      await api.post(`/api/game/${it.game_id}/finish`, {
        orders: game.log, saved_t: game.now, summary: res.summary, trades: res.trades, equity: res.equity, monkey: [], achievements: [],
      });
    } catch (e) {
      console.error(e);
      toast(`第 ${done + 1} 局失敗:${e.message}`, 'bad');
    }
    done++;
    pb.style.width = (100 * done / plan.length) + '%';
    pt.textContent = `${done} / ${plan.length} 局,累計 ${Math.round(total).toLocaleString()} 元`;
    await new Promise(r => setTimeout(r, 0));
  }
  wrap.remove();
  invalidate();
  toast(`${c.name} 跑完 ${done} 局,累計 ${Math.round(total).toLocaleString()} 元`, 'good', 4000);
}

export function describeSpec(spec, reveal) {
  const seg = spec.segments || [];
  if (!reveal && spec.blind) {
    if (spec.format === 'quick') return '快速局 · 日盤＋夜盤';
    return `${({ hour: '一小時局', session: '整盤' })[spec.format] || ''} · ${spec.label}`;
  }
  const d = spec.date;
  const when = spec.format === 'quick' ? `${d}(${weekday(d)})日盤＋夜盤` : `${d}(${weekday(d)})${spec.label}`;
  return `${when} · ${seg.length ? '' : ''}${spec.month} 月份`;
}
export { KIND, md };
