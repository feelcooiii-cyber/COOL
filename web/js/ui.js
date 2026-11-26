// 共用介面元件:對話框、提示、確認、段位徽章、頭像
import { esc } from './util.js';

export function toast(msg, kind = 'info', ms = 2600) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

// 對話框:body 是 HTML 字串;buttons = [{label, kind, value}];回傳 Promise(按了哪個 value;關掉 = null)
export function modal({ title, body, buttons = [{ label: '關閉', value: null }], wide = false, onMount }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title || '')}</h3><button class="icon-btn" data-x aria-label="關閉">✕</button></div>
      <div class="modal-body">${body || ''}</div>
      <div class="modal-foot">${buttons.map((b, i) => `<button class="btn ${b.kind || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
    </div>`;
    const close = v => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(null); });
    wrap.querySelector('[data-x]').onclick = () => close(null);
    wrap.querySelectorAll('.modal-foot [data-i]').forEach(b => {
      b.onclick = () => {
        const def = buttons[+b.dataset.i];
        if (def.validate) { const err = def.validate(wrap); if (err) { toast(err, 'warn'); return; } }
        close(def.collect ? def.collect(wrap) : def.value);
      };
    });
    root.appendChild(wrap);
    if (onMount) onMount(wrap, close);
  });
}

export async function confirmBox(title, text, okLabel = '確定', kind = 'primary') {
  const v = await modal({ title, body: `<p>${esc(text)}</p>`, buttons: [{ label: '取消', value: false }, { label: okLabel, kind, value: true }] });
  return v === true;
}

export function avatar(c, size = 40) {
  return `<span class="avatar" style="--c:${esc(c.color || '#4f8cff')};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc(c.kind === 'monkey' ? '猴' : (String(c.name || '?').trim()[0] || '?'))}</span>`;
}

export function rankBadge(rank) {
  return `<span class="rank r-${rank.code}" title="下一步:${esc(rank.next || '')}">${esc(rank.name)}</span>`;
}
