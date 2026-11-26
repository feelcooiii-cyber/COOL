// 排行榜:所有參賽者並排(只算正式賽與情境關卡)。灰色 = 不到 30 筆,先別比。
import { contestantStats } from '../stats.js';
import { avatar, rankBadge } from '../ui.js';
import { esc, fmtInt, fmtNum, fmtPct, fmtSigned, upDn } from '../util.js';
import { loadOverview, prod } from '../state.js';

const COLS = [
  { k: 'rank', t: '段位', v: r => r.S.rank.level },
  { k: 'n', t: '筆數', v: r => r.S.st.n || 0 },
  { k: 'win', t: '勝率', v: r => r.S.st.winRate ?? -1 },
  { k: 'payoff', t: '風報比', v: r => r.S.st.payoff ?? -1 },
  { k: 'exp', t: '期望值(元/筆)', v: r => r.S.st.exp ?? -Infinity },
  { k: 'pts', t: '點/口', v: r => r.S.st.expPts ?? -Infinity },
  { k: 'pf', t: '獲利因子', v: r => (r.S.st.pf === Infinity ? 1e9 : r.S.st.pf ?? -1) },
  { k: 'total', t: '總損益', v: r => r.S.st.total ?? -Infinity },
  { k: 'dd', t: '最大回撤', v: r => -(r.S.st.maxDD ?? 0) },
  { k: 'beat', t: '贏過猴子', v: r => r.S.beat ?? -1 },
];

export async function boardScreen(view) {
  const ov = await loadOverview(true);
  const rows = ov.contestants.map(c => ({ c, S: contestantStats(c, ov, { mult: prod(c.product).mult }) }));
  let sortK = 'exp', dir = -1;
  const draw = () => {
    const col = COLS.find(x => x.k === sortK);
    const sorted = [...rows].sort((a, b) => {
      const small = (a.S.st.n || 0) < 30, smallB = (b.S.st.n || 0) < 30;
      if (small !== smallB) return small ? 1 : -1;
      return dir * (col.v(a) - col.v(b));
    });
    view.innerHTML = `<div class="page-head"><h1>排行榜</h1><span class="note">只算正式賽與情境關卡,扣完成本。灰色 = 不到 30 筆,先別比。點欄位名稱排序。</span></div>
    <div class="card" style="overflow:auto"><table class="t big"><thead><tr><th>#</th><th>參賽者</th><th>商品</th>
      ${COLS.map(x => `<th class="sort r" data-k="${x.k}">${esc(x.t)}${x.k === sortK ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead><tbody>
      ${sorted.map((r, i) => { const s = r.S.st; return `<tr class="click ${(s.n || 0) < 30 ? 'dimrow' : ''}" data-c="${r.c.id}"><td>${i + 1}</td>
        <td><div class="row">${avatar(r.c, 28)}<b>${esc(r.c.name)}</b>${r.c.kind === 'monkey' ? '<span class="pill">猴子</span>' : ''}</div></td><td>${esc(prod(r.c.product).name)}</td>
        <td class="r">${r.c.kind === 'monkey' ? '<span class="rank r-rookie">對照組</span>' : rankBadge(r.S.rank)}</td><td class="r">${fmtInt(s.n)}</td><td class="r">${fmtPct(s.winRate)}</td>
        <td class="r">${s.payoff == null ? '—' : fmtNum(s.payoff, 2)}</td><td class="r ${upDn(s.exp)}">${fmtSigned(s.exp)}</td><td class="r ${upDn(s.expPts)}">${fmtSigned(s.expPts, 1)}</td>
        <td class="r">${s.pf == null ? '—' : s.pf === Infinity ? '∞' : fmtNum(s.pf, 2)}</td><td class="r ${upDn(s.total)}">${fmtSigned(s.total)}</td>
        <td class="r dn">${fmtInt(s.maxDD)}</td><td class="r">${r.c.kind === 'monkey' || r.S.beat == null ? '—' : fmtPct(r.S.beat)}</td></tr>`; }).join('')
        || '<tr><td colspan="13" class="dim">還沒有參賽者</td></tr>'}</tbody></table></div>
    <p class="note">期望值 = 平均每筆賺多少(扣手續費與期交稅)。風報比 = 平均賺 ÷ 平均賠。贏過猴子 = 同樣的行情、筆數、持有時間,隨機進場 200 次,你的總損益贏過幾成。</p>`;
    view.querySelectorAll('th.sort').forEach(th => th.onclick = () => { if (sortK === th.dataset.k) dir = -dir; else { sortK = th.dataset.k; dir = -1; } draw(); });
    view.querySelectorAll('tr[data-c]').forEach(tr => tr.onclick = () => { location.hash = '#/c/' + tr.dataset.c; });
  };
  draw();
}
