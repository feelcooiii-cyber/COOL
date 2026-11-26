// 手機版:API 不再連本機伺服器,改由瀏覽器裡的 local/api.js 處理(資料存在這台手機)
import { handle } from './local/api.js';

async function req(method, path, body) {
  const r = await handle(method, path, body);
  if (!r.ok) throw new Error((r.data && r.data.error) || ('錯誤 ' + r.code));
  return r.data;
}

export const api = {
  get: p => req('GET', p),
  post: (p, b = {}) => req('POST', p, b),
};
