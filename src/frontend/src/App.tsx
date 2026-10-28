import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { isThemeId, resolveTheme, type ThemeId } from './config/themes';
import { AppShell } from './layout/AppShell';
import { ConceptPage } from './pages/ConceptPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { ModelsPage } from './pages/ModelsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TutorialPage } from './pages/TutorialPage';
import { TaskQueuePage } from './pages/TaskQueuePage';
import { VectorPage } from './pages/VectorPage';

export default function App() {
  const [dark, setDark] = useState(() => localStorage.getItem('ui-color-scheme') === 'dark');
  const [theme, setTheme] = useState<ThemeId>(() => {
    const savedTheme = localStorage.getItem('ui-theme');
    return isThemeId(savedTheme) ? savedTheme : 'industrial';
  });
  useEffect(() => {
    const root = document.documentElement;
    const palette = resolveTheme(theme)[dark ? 'dark' : 'light'];
    root.dataset.theme = dark ? 'dark' : 'light';
    Object.entries(palette).forEach(([name, value]) => root.style.setProperty(`--${name}`, value));
    localStorage.setItem('ui-color-scheme', dark ? 'dark' : 'light');
    localStorage.setItem('ui-theme', theme);
  }, [dark, theme]);

  return <AppShell><Routes>
    <Route index element={<Navigate to="/tutorial" replace />} />
    <Route path="knowledge" element={<KnowledgePage />} />
    <Route path="concept" element={<ConceptPage />} />
    <Route path="tutorial" element={<TutorialPage />} />
    <Route path="models" element={<ModelsPage />} />
    <Route path="vector" element={<VectorPage />} />
    <Route path="tasks" element={<TaskQueuePage />} />
    <Route path="settings" element={<SettingsPage dark={dark} onDarkChange={setDark} theme={theme} onThemeChange={setTheme} />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></AppShell>;
}
