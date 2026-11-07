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
