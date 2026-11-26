// 資料與模型:行情目錄、價差校準、成交模型的驗證數字與限制
import { api } from '../api.js';
import { toast } from '../ui.js';
import { esc, fmtInt, fmtSigned, weekday } from '../util.js';
import { prod, state } from '../state.js';

export async function dataScreen(view) {
  let product = 'MTX';
  const [st, sp] = await Promise.all([api.get('/api/status'), api.get('/api/spread')]);
  const d = st.data || {};
  const src = st.sources || {};
  const dl = src.download;
  view.innerHTML = `<div class="page-head"><h1>資料與模型</h1><span class="spacer"></span>
    ${src.tks ? '<button class="btn" id="imp">立即檢查新資料</button>' : ''}
    <button class="btn ${src.tks ? '' : 'primary'}" id="dl">下載期交所最新行情</button></div>
  <div class="grid cols-3">
    <div class="card"><h4>期交所逐筆成交</h4><div class="big-pnl">${fmtInt(d.sessions)} 盤</div>
      <p class="note">${esc(d.first || '—')} ~ ${esc(d.last || '—')}。${src.tks ? '來源:TKS 每天傍晚下載的期交所檔(唯讀)。' : '來源:臺灣期貨交易所公開的「期貨每筆成交資料」。'}
      每一筆成交都有,時間只到秒,沒有買賣價。</p></div>
    ${src.tks ? `<div class="card"><h4>真實買賣價(另存)</h4><p class="note" style="margin-top:6px">TKS 錄的台指期、小台買一／賣一只保留 7 天;這裡每次啟動與每 30 分鐘另存一份,用來校準價差。
      只要一週內開過一次競技場,就不會漏。</p></div>`
    : `<div class="card"><h4>更新行情</h4><p class="note" style="margin-top:6px">按右上角「下載期交所最新行情」,會向期交所下載還沒有的交易日(期交所只保留最近 30 個交易日,
      交易日傍晚之後才有當天的檔)。一天約 5 MB,每天之間間隔 2 秒,下載完自動匯入。${dl && dl.at ? `<br>上次下載:${new Date(dl.at * 1000).toLocaleString('zh-TW')}${dl.error ? '(失敗:' + esc(dl.error) + ')' : `,新增 ${dl.got || 0} 天`}` : ''}</p></div>`}
    <div class="card"><h4>狀態</h4><p style="margin:6px 0">${esc(st.job.msg || '')}${st.job.total ? ` ${st.job.done}/${st.job.total}` : ''}</p><p class="note">${st.job.last_check ? '上次檢查 ' + new Date(st.job.last_check * 1000).toLocaleString('zh-TW') : ''}</p></div>
  </div>
  <div class="section"><h3>成交模型(怎麼做到不偏袒自己)</h3><div class="card">
    <p style="margin-top:0">期交所逐筆沒有買賣價,所以市價單的成交價用「最後一跳的方向」估:最後一筆往上跳,代表那筆成交在賣價,所以賣一 ≈ 最後成交價、買一 ≈ 最後成交價 − 典型價差;往下跳反過來。</p>
    <p>用群益錄到的真實買賣價驗證(11/11～11/18 夜盤,各 9 個一般盤;arena\\validate.py):</p>
    <table class="t big" style="max-width:760px"><thead><tr><th>市價單成交價的算法</th><th class="r">大台平均偏差</th><th class="r">小台平均偏差</th></tr></thead><tbody>
      <tr><td>直接用最後成交價</td><td class="r up">每次便宜 2.4～3.4 點</td><td class="r up">便宜 1.4～2.0 點</td></tr>
      <tr><td>依最後一跳方向 ± 典型價差(採用)</td><td class="r">−0.6～+0.8 點</td><td class="r">−0.2～+0.2 點</td></tr></tbody></table>
    <p class="note">長期統計幾乎不偏;單筆誤差中位數大台 2～4 點、小台 1～2 點。注意:價差是用同一批資料校準的(樣本內),之後累積更多天會再做樣本外驗證。
      只用成交價本身推估價差不可行(實測估出 1～2 點,真實是 3～7 點),所以真實買賣價很重要。</p>
    <ul class="note"><li>限價單:預設要價格「穿過」才成交(保守),結算時另外算「碰到就成交」的結果。</li>
      <li>一次下多口:最佳一檔通常只有 1～2 口,超過的每多一檔差 ${esc(String(state.settings.level_gap))} 點(沒有五檔資料,先用保守假設)。</li>
      <li>下單延遲 ${esc(String(state.settings.latency_ms))} 毫秒;開盤前送的單參加集合競價,用開盤價成交。</li>
      <li>成本:手續費(參賽者設定)＋期交稅十萬分之二;保證金照期交所公告,不足會追繳、跌破 25% 強制平倉。</li>
      <li>限制:你的單不會影響行情;同一秒裡的成交時間是平均分散的估計;微台沒有買賣價紀錄,先借用小台的價差。</li></ul>
  </div></div>
  <div class="section grid cols-2">
    <div class="card"><h4>價差校準(群益真實買賣價,每一盤的時間加權中位數)</h4><table class="t"><thead><tr><th>商品</th><th>盤別</th><th>快到期</th><th class="r">典型價差</th><th class="r">盤數</th></tr></thead><tbody>
      ${sp.calibration.map(r => `<tr><td>${esc(prod(r.product).name)}</td><td>${r.kind === 'D' ? '日盤' : '夜盤'}</td><td>${r.near ? '是' : ''}</td><td class="r">${r.median} 點</td><td class="r" title="${esc(r.days)}">${r.n}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">還沒有校準資料</td></tr>'}</tbody></table></div>
    <div class="card"><h4>撮合用的典型價差</h4><table class="t"><thead><tr><th>商品</th><th>盤別</th><th>快到期</th><th class="r">價差</th></tr></thead><tbody>
      ${sp.table.map(r => `<tr><td>${esc(prod(r.product).name)}</td><td>${r.kind === 'D' ? '日盤' : '夜盤'}</td><td>${r.near ? '是' : ''}</td><td class="r">${r.spread} 點</td></tr>`).join('')}</tbody></table>
      <p class="note">快到期 = 這個月份的結算日與前一個交易日(實測大台近月放大到 9～11 點)。</p></div>
  </div>
  <div class="section"><div class="row" style="margin-bottom:10px"><h3>行情目錄</h3><div class="seg" id="ps">${(st.product_order || ['MTX', 'TX', 'TMF']).map(p => `<button data-p="${p}">${esc(prod(p).name)}</button>`).join('')}</div>
    <span class="note">主力月份;灰色 = 已經被真人看過(正式賽不會再抽到)</span></div>
    <div class="card" style="overflow:auto"><table class="t big"><thead><tr><th>日期</th><th>盤別</th><th>月份</th><th class="r">成交筆數</th><th class="r">開盤</th><th class="r">收盤</th><th class="r">高低差</th><th class="r">跳空</th><th>盤型</th></tr></thead><tbody id="cat"></tbody></table></div></div>`;
  const draw = async () => {
    view.querySelectorAll('#ps button').forEach(b => b.classList.toggle('on', b.dataset.p === product));
    const cat = await api.get('/api/catalog?product=' + product);
    view.querySelector('#cat').innerHTML = [...cat].reverse().map(r => `<tr class="${r.seen ? 'dimrow' : ''}"><td>${esc(r.date)}(${weekday(r.date)})</td><td>${r.kind === 'D' ? '日盤' : '夜盤'}</td>
      <td>${esc(r.month)}${r.near ? ' <span class="pill warn">快到期</span>' : ''}</td><td class="r">${fmtInt(r.n)}</td><td class="r">${fmtInt(r.open)}</td><td class="r">${fmtInt(r.close)}</td>
      <td class="r">${fmtInt(r.range)}</td><td class="r">${r.gap == null ? '—' : fmtSigned(r.gap)}</td><td>${(r.tags || []).map(t => `<span class="pill">${esc(t)}</span>`).join(' ')}</td></tr>`).join('');
  };
  view.querySelectorAll('#ps button').forEach(b => b.onclick = () => { product = b.dataset.p; draw(); });
  if (view.querySelector('#imp')) view.querySelector('#imp').onclick = async () => { await api.post('/api/import'); toast('開始檢查新資料(右上角看進度)', 'info'); };
  view.querySelector('#dl').onclick = async () => {
    try { await api.post('/api/download'); toast('開始向期交所下載(右上角看進度;完成後畫面會自動更新)', 'info', 4000); }
    catch (e) { toast(e.message, 'warn'); }
  };
  const onData = () => window.dispatchEvent(new HashChangeEvent('hashchange'));   // 讓路由重畫這一頁
  window.addEventListener('arena:data', onData);
  await draw();
  return { destroy: () => window.removeEventListener('arena:data', onData) };
}
