import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { HelpProvider } from './help';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HelpProvider><App /></HelpProvider>
  </StrictMode>,
);
