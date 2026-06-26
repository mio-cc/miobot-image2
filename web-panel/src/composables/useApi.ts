import axios, { type AxiosInstance } from 'axios';
import { ref } from 'vue';

const TOKEN_KEY = 'miobot.panel.token';

/**
 * 统一 API 客户端：axios 实例 + Bearer 鉴权 + 登录。抽自 App.vue 散落的请求/鉴权逻辑。
 * 鉴权令牌取登录响应的 auth.token（= derivePanelToken(passwordSeed)），与重建后的 admin-service 一致。
 */
export function useApi(baseURL = `${window.location.origin}/api`) {
  const token = ref<string>(safeGet(TOKEN_KEY));
  const client: AxiosInstance = axios.create({ baseURL });

  client.interceptors.request.use((config) => {
    if (token.value) {
      const headers = config.headers as Record<string, unknown>;
      headers.Authorization = `Bearer ${token.value}`;
    }
    return config;
  });

  function setToken(next: string): void {
    token.value = next || '';
    try {
      if (next) localStorage.setItem(TOKEN_KEY, next);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* 隐私模式下 localStorage 不可用，忽略 */ }
  }

  async function login(password: string): Promise<unknown> {
    const { data } = await client.post('/login', { password });
    const next = (data && (data.auth?.token ?? data.token)) || '';
    if (next) setToken(String(next));
    return data;
  }

  function logout(): void { setToken(''); }

  return { client, token, setToken, login, logout };
}

export type ApiClient = ReturnType<typeof useApi>['client'];

function safeGet(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
