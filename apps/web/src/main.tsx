import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installPressEffects } from './components/motion';
import { startReveal } from './features/e2ee/service';
import { startBadge } from './features/shell/badge';
import { startAppearance } from './features/settings/appearance';
import { watchInstallPrompt } from './features/settings/install';
import './styles/index.css';

startAppearance();
// A saved copy of the page can point at files a newer release has removed. Reloading once gets the current ones.
window.addEventListener('vite:preloadError', () => {
  try {
    if (Date.now() - Number(sessionStorage.getItem('strata:reloaded') ?? 0) < 30_000) return;
    sessionStorage.setItem('strata:reloaded', String(Date.now()));
  } catch {
    return;
  }
  location.reload();
});
startBadge();
startReveal();
watchInstallPrompt();
installPressEffects();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
