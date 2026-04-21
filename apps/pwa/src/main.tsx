import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { IntlProvider } from './i18n/IntlProvider';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <IntlProvider>
      <App />
    </IntlProvider>
  </React.StrictMode>
);

requestAnimationFrame(() => {
  const splash = document.getElementById('app-splash');
  if (!splash) return;
  splash.classList.add('fade-out');
  splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  setTimeout(() => splash.remove(), 600);
});
