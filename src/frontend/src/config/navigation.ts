import { type LucideIcon, AppWindow, BookOpenCheck, Bot, DatabaseZap, LibraryBig, ListTodo, MessageCircleQuestionMark, Network } from 'lucide-react';

export interface NavigationItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

export interface NavigationGroup {
  label: string;
  icon: LucideIcon;
  items: NavigationItem[];
}

export const navigationGroups: NavigationGroup[] = [
  {
    label: '论文管理',
    icon: LibraryBig,
    items: [
      { label: '论文列表', path: '/tutorial', icon: BookOpenCheck },
      { label: '论文分类', path: '/concept', icon: Network }
    ]
  },
  {
    label: '研究工作',
    icon: MessageCircleQuestionMark,
    items: [
      { label: '知识问答', path: '/knowledge', icon: MessageCircleQuestionMark },
      { label: '内容检索', path: '/vector', icon: DatabaseZap }
    ]
  },
  {
    label: '应用服务',
    icon: AppWindow,
    items: [
      { label: '模型选择', path: '/models', icon: Bot },
      { label: '任务队列', path: '/tasks', icon: ListTodo }
    ]
  }
];
