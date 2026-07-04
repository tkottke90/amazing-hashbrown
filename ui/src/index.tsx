import { render } from 'preact';
import { App } from './app';
import { ThemeProvider } from './hooks/use-theme';
import './style.css';

render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
  document.getElementById('app')!,
);
