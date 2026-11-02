import { createApp } from 'vue';
import { createPinia } from 'pinia';
/* 宣纸版式标题字体（本地化，无 CDN 依赖；回退系统宋体/衬线栈） */
import '@fontsource/noto-serif-sc/600.css';
import '@fontsource/noto-serif-sc/700.css';
import './style.css';
import App from './App.vue';
import { router } from './router';

createApp(App)
    .use(createPinia())
    .use(router)
    .mount('#app');
