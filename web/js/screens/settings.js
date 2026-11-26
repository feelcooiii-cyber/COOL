// 設定:成交規則、智慧快轉、音效、保證金…(改了之後新開的局才生效;已經開始的局用開局時的設定)
import { api } from '../api.js';
import { toast } from '../ui.js';
import { esc } from '../util.js';
import { loadSettings, prod, state } from '../state.js';

export async function settingsScreen(view) {
  const s = await loadSettings();
  const P = state.status.product_order || ['MTX', 'TX', 'TMF'];
  const num = (id, v, unit = '', step = 1, w = 90) => `<div class="row"><input type="number" id="${id}" value="${v}" step="${step}" min="0" style="width:${w}px"><span class="note">${esc(unit)}</span></div>`;
  view.innerHTML = `<div class="page-head"><h1>設定</h1><span class="note">改了之後新開的局才生效;已經開始的局用開局時的設定</span><span class="spacer"></span><button class="btn primary" id="save">儲存</button></div>
  <div class="grid cols-2">
    <fieldset><legend>成交規則</legend><div class="form">
      <label>下單延遲</label>${num('latency_ms', s.latency_ms, '毫秒(市場時間)', 50)}
      <label>限價單成交</label><select id="fill_rule"><option value="through" ${s.fill_rule === 'through' ? 'selected' : ''}>價格穿過才成交(保守,建議)</option>
        <option value="touch" ${s.fill_rule === 'touch' ? 'selected' : ''}>碰到就成交(樂觀)</option></select>
      <label>多口滑價</label>${num('level_gap', s.level_gap, '點/每多一檔')}
      <label>追價定義</label><div class="row">進場前 <input type="number" id="chase_sec" value="${s.chase_sec}" style="width:60px"> 秒內已經往同方向走 <input type="number" id="chase_pts" value="${s.chase_pts}" style="width:60px"> 點以上</div>
    </div></fieldset>
    <fieldset><legend>比賽</legend><div class="form">
      <label>正式賽只用沒看過的行情</label><label class="chk"><input type="checkbox" id="unseen_rule" ${s.unseen_rule ? 'checked' : ''}> 開(建議;關掉的話成績可能被記憶影響)</label>
      <label>隱藏價位</label><label class="chk"><input type="checkbox" id="hide_price" ${s.hide_price ? 'checked' : ''}> 正式賽把價位平移,避免認出是哪一天</label>
      <label>智慧快轉</label><label class="chk"><input type="checkbox" id="smart_fast" ${s.smart_fast ? 'checked' : ''}> 新的局預設打開</label>
      <label>快轉倍速</label>${num('fast_speed', s.fast_speed, '×(沒部位、行情安靜時)')}
      <label>放慢條件</label><div class="row"><input type="number" id="move_sec" value="${s.move_sec}" style="width:60px"> 秒內動 <input type="number" id="move_pts" value="${s.move_pts}" style="width:60px"> 點以上</div>
      <label>音效</label><label class="chk"><input type="checkbox" id="sound" ${s.sound ? 'checked' : ''}> 成交、停損、成就音效</label>
    </div></fieldset>
    <fieldset class="full"><legend>商品(保證金請照期交所最新公告)</legend>
      <table class="t big"><thead><tr><th>商品</th><th>原始保證金</th><th>維持保證金</th><th>最佳一檔口數</th><th>大單門檻(口)</th></tr></thead><tbody>
      ${P.map(p => `<tr><td>${esc(prod(p).name)}(每點 ${prod(p).mult} 元)</td>
        <td><input type="number" data-p="${p}" data-k="im" value="${s.margins[p].im}" style="width:110px"></td>
        <td><input type="number" data-p="${p}" data-k="mm" value="${s.margins[p].mm}" style="width:110px"></td>
        <td><input type="number" data-p="${p}" data-k="l1" value="${s.l1[p]}" style="width:70px"></td>
        <td><input type="number" data-p="${p}" data-k="big" value="${s.big_lots[p]}" style="width:70px"></td></tr>`).join('')}</tbody></table>
    </fieldset>
    <fieldset><legend>快速鍵</legend><table class="t big"><tbody>
      ${[['空白鍵', '開始／暫停'], ['B / S', '市價買／賣'], ['F', '平倉'], ['R', '反手'], ['C', '全部撤單'], ['Q / W', '限價買／賣(再點圖選價位)'],
        ['A / Z', '停損買／賣(觸價,再點圖選價位)'], ['Esc', '取消選價'], ['1 / 2 / 3', '1／5／15 分 K'], ['＋ / −', '口數'], ['↑ / ↓', '倍速'], ['拖曳委託線', '改價']]
        .map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></fieldset>
    <fieldset><legend>關於</legend><p class="note" style="margin-top:0">台指競技場 ${esc(state.status.version)}。行情:期交所逐筆成交(TKS 下載,唯讀)。
      K 線圖:TradingView Lightweight Charts™ 4.2.3(Apache License 2.0,Copyright TradingView, Inc.)。</p>
      <p class="note">這是練習與研究工具,不會連任何下單元件,也不會送出真的單。</p></fieldset>
  </div>`;
  view.querySelector('#save').onclick = async () => {
    const v = id => view.querySelector('#' + id);
    const n = id => Math.max(0, Number(v(id).value) || 0);
    const margins = {}, l1 = {}, big = {};
    view.querySelectorAll('input[data-p]').forEach(i => {
      const p = i.dataset.p, k = i.dataset.k, x = Math.max(0, Number(i.value) || 0);
      if (k === 'im' || k === 'mm') { margins[p] = margins[p] || {}; margins[p][k] = x; }
      else if (k === 'l1') l1[p] = Math.max(1, Math.round(x));
      else big[p] = Math.max(1, Math.round(x));
    });
    const body = {
      latency_ms: n('latency_ms'), fill_rule: v('fill_rule').value, level_gap: n('level_gap'), chase_sec: n('chase_sec'), chase_pts: n('chase_pts'),
      unseen_rule: v('unseen_rule').checked, hide_price: v('hide_price').checked, smart_fast: v('smart_fast').checked, fast_speed: Math.max(1, n('fast_speed')),
      move_sec: n('move_sec'), move_pts: n('move_pts'), sound: v('sound').checked, margins, l1, big_lots: big,
    };
    try { await api.post('/api/settings', body); await loadSettings(); toast('設定已儲存', 'good'); } catch (e) { toast(e.message, 'bad'); }
  };
}
