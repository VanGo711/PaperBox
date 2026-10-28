import { LogIn, UserRound } from 'lucide-react';
import { useState } from 'react';
import { themeOptions, type ThemeId } from '../config/themes';

interface SettingsPageProps {
  dark: boolean;
  onDarkChange(value: boolean | ((current: boolean) => boolean)): void;
  theme: ThemeId;
  onThemeChange(value: ThemeId): void;
}

export function SettingsPage({ dark, onDarkChange, theme, onThemeChange }: SettingsPageProps) {
  const [loginMessage, setLoginMessage] = useState('尚未接入身份服务');
  return <div className="page settings-page"><section className="page-intro"><p>界面与账户</p><h1>设置</h1><span>账户、显示偏好和界面切换统一在此处管理。</span></section><section className="settings-card"><div><strong>显示模式</strong><span>切换工作台的明暗外观</span></div><button className="switch" aria-pressed={dark} onClick={() => onDarkChange((value) => !value)}><i /></button></section><section className="theme-settings"><div className="theme-heading"><div><strong>主题配色</strong><span>选择后即时应用到整个工作台</span></div></div><div className="theme-grid">{themeOptions.map((option) => <button key={option.id} className={`theme-option${theme === option.id ? ' active' : ''}`} onClick={() => onThemeChange(option.id)} aria-pressed={theme === option.id}><span className="theme-swatches">{option.colors.map((color) => <i key={color} style={{ background: color }} />)}</span><strong>{option.name}</strong><small>{option.description}</small></button>)}</div></section><section className="settings-card"><div><strong>用户账户</strong><span>{loginMessage}</span></div><button className="settings-action" onClick={() => setLoginMessage('登录界面将在身份服务接入后启用')}><LogIn size={16} />登录</button></section><section className="settings-card"><div><strong>界面状态</strong><span>项目当前为从 IMDM 抽离出的纯 UI 骨架</span></div><span className="status-pill"><UserRound size={14} />离线模式</span></section></div>;
}
