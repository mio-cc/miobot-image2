import { defineStore } from 'pinia';
import { ref } from 'vue';
import client, { errorMessage } from '../api/client';

/**
 * 会话。token 由后端从面板密码派生（derivePanelToken），改密码即失效。
 * 后端没有 /logout——token 不是服务端签发的一次性凭据，本地丢弃即可。
 */
export const useAuthStore = defineStore('auth', () => {
    const token = ref(localStorage.getItem('miobot_token') || '');
    const isAuthenticated = ref(false);
    const loginError = ref('');
    /** 后端认为仍是默认密码时置位，设置页会显红条。由 config store 在每次拿到 auth 快照时更新。 */
    const usingDefaultPassword = ref(false);

    function setToken(value: string) {
        token.value = value;
        if (value) localStorage.setItem('miobot_token', value);
        else localStorage.removeItem('miobot_token');
    }

    async function login(password: string) {
        loginError.value = '';
        try {
            const res = await client.post('/login', { password });
            const next = res.data?.auth?.token;
            if (!next) {
                loginError.value = '登录响应缺少会话令牌';
                return false;
            }
            setToken(next);
            // 注意：这里**不**置 isAuthenticated。
            // 一置位登录页立刻被卸载，随后的 emit('success') 就可能发不出去，
            // 结果是拿到了会话却没人去加载配置，界面停在一个空壳上。
            // 「已登录」的定义是"有会话且配置已加载"，由 App 在加载成功后置位。
            return true;
        } catch (error: any) {
            loginError.value = errorMessage(error, '登录失败');
            return false;
        }
    }

    function logout() {
        setToken('');
        isAuthenticated.value = false;
    }

    function sessionExpired(reason: string) {
        setToken('');
        isAuthenticated.value = false;
        loginError.value = reason;
    }

    return { token, isAuthenticated, loginError, usingDefaultPassword, setToken, login, logout, sessionExpired };
});
