import axios from 'axios';

/**
 * 统一的 API 客户端。
 *
 * 集中做三件事：
 * 1. 自动注入会话 token（否则每个请求都要手写 Authorization 头）
 * 2. 401 统一处理——不然保存配置收到 401 时只会显示
 *    "Request failed with status code 401"，用户对着一屏未保存的改动发懵
 * 3. 错误信息归一化（后端返回 {error} 时优先用它，而不是 axios 的通用文案）
 */

export const API_BASE = `${window.location.origin}/api`;

const client = axios.create({ baseURL: API_BASE, timeout: 120_000 });

let sessionExpiredHandler: ((reason: string) => void) | undefined;
let tokenGetter: (() => string) | undefined;

export function configureApi(options: {
    getToken: () => string;
    onSessionExpired: (reason: string) => void;
}) {
    tokenGetter = options.getToken;
    sessionExpiredHandler = options.onSessionExpired;
}

client.interceptors.request.use(config => {
    const token = tokenGetter?.();
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
});

client.interceptors.response.use(
    response => response,
    error => {
        if (error?.response?.status === 401) {
            // 登录接口自己的 401 是"密码错误"，不该被当成会话过期。
            const isLoginCall = String(error.config?.url || '').includes('/login');
            if (!isLoginCall) sessionExpiredHandler?.('登录已过期，请重新登录');
        }
        return Promise.reject(error);
    },
);

/** 把后端返回的错误文案抽出来，取不到再退回 axios 的 message。 */
export function errorMessage(error: any, fallback = '请求失败') {
    return error?.response?.data?.error || error?.message || fallback;
}

export default client;
