// 全域狀態:伺服器狀態、設定、戰績總覽(大廳、排行榜、日誌共用)
import { api } from './api.js';
import { setSound } from './sound.js';

export const state = { status: null, settings: null, overview: null, overviewAt: 0 };

export async function loadStatus() {
  state.status = await api.get('/api/status');
  return state.status;
}
export async function loadSettings() {
  state.settings = await api.get('/api/settings');
  setSound(state.settings.sound);
  return state.settings;
}
export async function loadOverview(force = false) {
  if (!force && state.overview && Date.now() - state.overviewAt < 3000) return state.overview;
  state.overview = await api.get('/api/overview');
  state.overviewAt = Date.now();
  return state.overview;
}
export function invalidate() { state.overviewAt = 0; }
export function prod(code) { return (state.status && state.status.products[code]) || { name: code, mult: 50 }; }
export function prodName(code) { return prod(code).name; }
