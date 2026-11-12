import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ToastProvider } from './components/Toast.jsx';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource/instrument-serif/latin-400-italic.css';
import './styles.css';
import { watchForNewBuild } from './staleBuild.js';

// After a deploy, a tab running the old build reloads itself instead of crashing on a missing file.
watchForNewBuild();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
