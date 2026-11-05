import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installPressEffects } from './components/motion';
import './styles/index.css';

const theme = (() => {
  try {
    return localStorage.getItem('strata:theme');
  } catch {
    return null;
  }
})();
if (theme === 'day') document.documentElement.dataset.theme = theme;
installPressEffects();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
