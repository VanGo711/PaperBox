export type ThemeId = 'industrial' | 'technology' | 'intelligence' | 'energy';

export type ThemePalette = Record<
  'primary' | 'primary-weak' | 'secondary-selected' | 'page' | 'surface' | 'surface-muted' | 'border' | 'line' | 'text' | 'muted' | 'sider' | 'shadow',
  string
>;

export interface ThemeOption {
  id: ThemeId;
  name: string;
  description: string;
  colors: [string, string, string];
  light: ThemePalette;
  dark: ThemePalette;
}

const lightBase = {
  surface: '#ffffff',
  'surface-muted': '#f7fafb',
  text: '#17252c',
  muted: '#72828a',
  sider: '#ffffff',
  shadow: '0 12px 30px rgba(19,49,63,.08)'
};

const darkBase = {
  surface: '#17242a',
  'surface-muted': '#1b2b31',
  text: '#e4eef1',
  muted: '#9baeb5',
  sider: '#142126',
  shadow: '0 12px 30px rgba(0,0,0,.22)'
};

export const themeOptions: ThemeOption[] = [
  {
    id: 'industrial', name: '智造蓝', description: '稳健、清晰的工业设计配色', colors: ['#1f668a', '#e0eef4', '#f3f7f9'],
    light: { ...lightBase, primary: '#1f668a', 'primary-weak': '#e0eef4', 'secondary-selected': '#c8e4ee', page: '#f3f7f9', border: '#d9e4e9', line: '#e9eff2' },
    dark: { ...darkBase, primary: '#5fa9ce', 'primary-weak': '#1a3848', 'secondary-selected': '#285064', page: '#111b20', border: '#29414b', line: '#21363e' }
  },
  {
    id: 'technology', name: '精工青', description: '克制、自然的科技绿调', colors: ['#087a71', '#d9efec', '#f2f8f7'],
    light: { ...lightBase, primary: '#087a71', 'primary-weak': '#d9efec', 'secondary-selected': '#c4e6e1', page: '#f2f8f7', border: '#d7e6e3', line: '#e5f0ed' },
    dark: { ...darkBase, primary: '#58b9af', 'primary-weak': '#173f3c', 'secondary-selected': '#225c56', page: '#11201f', border: '#294844', line: '#203936' }
  },
  {
    id: 'intelligence', name: '算力紫', description: '理性、前沿的智能计算配色', colors: ['#6958a6', '#e8e4f5', '#f6f4fa'],
    light: { ...lightBase, primary: '#6958a6', 'primary-weak': '#e8e4f5', 'secondary-selected': '#d9d2ee', page: '#f6f4fa', border: '#e1deea', line: '#eeecf3' },
    dark: { ...darkBase, primary: '#a998e5', 'primary-weak': '#312b4b', 'secondary-selected': '#4a4172', page: '#1b1826', border: '#433d59', line: '#302b42' }
  },
  {
    id: 'energy', name: '能源橙', description: '温暖、醒目的工程活力配色', colors: ['#a85b17', '#f4e3d1', '#faf6f1'],
    light: { ...lightBase, primary: '#a85b17', 'primary-weak': '#f4e3d1', 'secondary-selected': '#f1d3b4', page: '#faf6f1', border: '#eadfd3', line: '#f3ebe3' },
    dark: { ...darkBase, primary: '#e1a467', 'primary-weak': '#50341f', 'secondary-selected': '#704827', page: '#251b14', border: '#573e2b', line: '#3e2d20' }
  }
];

export function isThemeId(value: string | null): value is ThemeId {
  return themeOptions.some((theme) => theme.id === value);
}

export function resolveTheme(theme: ThemeId): ThemeOption {
  return themeOptions.find((option) => option.id === theme) ?? themeOptions[0]!;
}
