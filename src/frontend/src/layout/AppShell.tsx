import { Settings } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { NavigationGroup } from '../components/NavigationGroup';
import { navigationGroups } from '../config/navigation';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('ui-sider-collapsed') === 'true');
  const [expandedGroups, setExpandedGroups] = useState<string[]>(() => navigationGroups.map((group) => group.label));

  const setSidebarCollapsed = (next: boolean) => {
    setCollapsed(next);
    localStorage.setItem('ui-sider-collapsed', String(next));
  };
  const collapseNavigation = () => { if (!collapsed) setSidebarCollapsed(true); };
  const expandNavigation = () => {
    setSidebarCollapsed(false);
    setExpandedGroups(navigationGroups.map((group) => group.label));
  };
  const toggleGroup = (label: string) => {
    if (collapsed) {
      expandNavigation();
      return;
    }
    setExpandedGroups((openGroups) => openGroups.includes(label) ? openGroups.filter((name) => name !== label) : [...openGroups, label]);
  };

  return <div className={`app-layout${collapsed ? ' is-collapsed' : ''}`}>
    <aside className="app-sider" onDoubleClick={expandNavigation}>
      <button className="brand" onClick={() => navigate('/')} aria-label="返回工作台"><span className="brand-mark">文</span><span className="brand-name">论文管理</span></button>
      <nav className="navigation" aria-label="主导航">
        {navigationGroups.map((group) => <NavigationGroup key={group.label} group={group} currentPath={pathname} collapsed={collapsed} expanded={expandedGroups.includes(group.label)} onToggle={toggleGroup} onNavigate={navigate} />)}
      </nav>
      <div className="sider-footer"><button title={collapsed ? '设置' : undefined} className={`side-action${pathname === '/settings' ? ' active' : ''}`} onClick={() => navigate('/settings')}><Settings size={18} /><span>设置</span></button></div>
    </aside>
    <main className="main-layout"><section className={`app-content${pathname === '/knowledge' || pathname === '/design' || pathname === '/tutorial' || pathname === '/models' || pathname === '/vector' || pathname === '/concept' || pathname === '/experience' || pathname === '/tasks' ? ' app-content-full' : ''}`} onDoubleClick={collapseNavigation}>{children}</section></main>
  </div>;
}
