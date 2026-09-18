import type { ReactNode } from 'react';

export type ShellMode = 'standalone' | 'hosted-content';
export type ThemeChoice = 'dark' | 'light';

export interface NavigationItem {
  id: string;
  label: string;
  href: string;
  current: boolean;
  count?: number;
}

export interface ThemePort {
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
}

export interface PageFrameModel {
  title: string;
  description?: string;
  labelledBy: string;
}

export interface AiurShellProps {
  mode: ShellMode;
  navigation: NavigationItem[];
  actions?: ReactNode;
  theme: ThemePort;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  children: ReactNode;
}

export interface KhalaPageFrameProps {
  model: PageFrameModel;
  banner?: ReactNode;
  children: ReactNode;
}
