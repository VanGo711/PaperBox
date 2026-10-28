import { ChevronDown } from 'lucide-react';
import type { NavigationGroup as NavigationGroupDefinition } from '../config/navigation';

interface NavigationGroupProps {
  group: NavigationGroupDefinition;
  currentPath: string;
  collapsed: boolean;
  expanded: boolean;
  onToggle(label: string): void;
  onNavigate(path: string): void;
}

export function NavigationGroup({ group, currentPath, collapsed, expanded, onToggle, onNavigate }: NavigationGroupProps) {
  const GroupIcon = group.icon;
  const children = <div className="nav-children">
    {group.items.map((item) => {
      const Icon = item.icon;
      const active = currentPath === item.path;
      return <button key={item.path} title={collapsed ? item.label : undefined} className={`nav-item${active ? ' active' : ''}`} onClick={() => onNavigate(item.path)}>
        <Icon size={collapsed ? 16 : 17} />
        <span>{item.label}</span>
      </button>;
    })}
  </div>;

  return <section className={`nav-group${expanded ? ' is-open' : ''}`}>
    <button className="nav-group-toggle" title={collapsed ? group.label : undefined} aria-expanded={collapsed ? false : expanded} onClick={() => onToggle(group.label)}>
      <GroupIcon size={collapsed ? 19 : 18} />
      <span>{group.label}</span>
      <ChevronDown className="group-chevron" size={15} />
    </button>
    {collapsed || expanded ? children : null}
  </section>;
}
