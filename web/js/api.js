// 和本機伺服器溝通(每個請求都帶 X-Arena 標頭,別的網站送不進來)
async function req(method, path, body) {
  const opt = { method, headers: { 'X-Arena': '1' } };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(path, opt);
  } catch (e) {
    throw new Error('連不到台指競技場伺服器,請重新開啟程式');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

export const api = {
  get: p => req('GET', p),
  post: (p, b = {}) => req('POST', p, b),
};
