import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { syncBrandingFromApi } from './branding';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('未找到 #root 挂载点');

// 站点名称与图标是管理员在「后台 → 站点设置」里配的，存在服务端：先按公开接口把页面标题与
// favicon 调好。不等它 —— 拉得慢也不该拖住首屏，登录后 `/api/session` 会再下发一次并覆盖。
void syncBrandingFromApi();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
