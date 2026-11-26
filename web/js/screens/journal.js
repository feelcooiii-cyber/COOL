// 交易日誌:所有交易(可以篩選參賽者、模式、理由),點一列回到那一局的結算畫面
import { FORMAT_NAME, MODE_NAME } from '../stats.js';
import { dur, esc, fmtInt, fmtNum, fmtSigned, hms, upDn, weekday } from '../util.js';
import { loadOverview, prod } from '../state.js';

export async function journalScreen(view) {
  const ov = await loadOverview(true);
  const cs = new Map(ov.contestants.map(c => [c.id, c]));
  const games = new Map(ov.games.map(g => [g.id, g]));
  const f = { c: '', mode: '', tag: '', q: '' };
  const tags = [...new Set(ov.trades.map(t => t.tag).filter(Boolean))];
  view.innerHTML = `<div class="page-head"><h1>交易日誌</h1><span class="spacer"></span>
    <select id="fc"><option value="">全部參賽者</option>${ov.contestants.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
    <select id="fm"><option value="">全部模式</option>${Object.entries(MODE_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <select id="ft"><option value="">全部理由</option>${tags.map(t => `<option>${esc(t)}</option>`).join('')}</select>
    <input type="text" id="fq" placeholder="搜尋心得"></div>
    <div class="card" style="overflow:auto"><table class="t big"><thead><tr><th>參賽者</th><th>模式</th><th>行情</th><th>進場</th><th>多空</th><th class="r">口</th>
    <th class="r">點數</th><th class="r">損益</th><th class="r">R</th><th>持有</th><th>理由</th><th>照策略</th><th>心得</th></tr></thead><tbody id="rows"></tbody></table></div>
    <p class="note" id="cnt"></p>`;
  const draw = () => {
    const list = ov.trades.filter(t => (!f.c || t.contestant_id === +f.c) && (!f.mode || t.mode === f.mode) && (!f.tag || t.tag === f.tag)
      && (!f.q || (t.note || '').includes(f.q))).sort((a, b) => b.entry_t - a.entry_t).slice(0, 1000);
    view.querySelector('#rows').innerHTML = list.map(t => {
      const c = cs.get(t.contestant_id), g = games.get(t.game_id) || {}, s = g.summary || {};
      if (!c) return '';
      return `<tr class="click" data-g="${t.game_id}"><td>${esc(c.name)}</td><td>${esc(MODE_NAME[t.mode] || '')} · ${esc(FORMAT_NAME[t.format] || '')}</td>
        <td>${esc(s.date || '')}${s.date ? `(${weekday(s.date)})` : ''}</td><td>${hms(t.entry_t * 1000)}</td><td class="${t.dir > 0 ? 'up' : 'dn'}">${t.dir > 0 ? '多' : '空'}</td>
        <td class="r">${t.qty}</td><td class="r ${upDn(t.points)}">${fmtSigned(t.points, 1)}</td><td class="r ${upDn(t.pnl)}">${fmtSigned(t.pnl)}</td>
        <td class="r">${t.r == null ? '—' : fmtNum(t.r, 1)}</td><td>${dur(t.hold * 1000)}</td><td>${esc(t.tag || '')}</td>
        <td>${t.followed === 1 ? '照' : t.followed === 0 ? '<span class="warn">沒照</span>' : ''}</td><td style="white-space:normal;max-width:320px">${esc(t.note || '')}</td></tr>`;
    }).join('') || '<tr><td colspan="13" class="dim">沒有符合的交易</td></tr>';
    view.querySelector('#cnt').textContent = `${list.length} 筆(最多顯示 1,000 筆)· 合計 ${fmtSigned(list.reduce((a, t) => a + t.pnl, 0))} 元`;
    view.querySelectorAll('tr[data-g]').forEach(tr => tr.onclick = () => { location.hash = '#/result/' + tr.dataset.g; });
  };
  view.querySelector('#fc').onchange = e => { f.c = e.target.value; draw(); };
  view.querySelector('#fm').onchange = e => { f.mode = e.target.value; draw(); };
  view.querySelector('#ft').onchange = e => { f.tag = e.target.value; draw(); };
  view.querySelector('#fq').oninput = e => { f.q = e.target.value.trim(); draw(); };
  draw();
  void prod; void fmtInt;
}
