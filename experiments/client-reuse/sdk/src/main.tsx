import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
createRoot(document.getElementById('root')!).render(<App embedded={new URLSearchParams(location.search).has('embedded')} />);
