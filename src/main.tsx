import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installSafeFetchDescriptor } from './utils/jarvisEngine.ts';

if (typeof window !== 'undefined') {
  installSafeFetchDescriptor(window as unknown as Record<string, unknown>);
}

createRoot(document.getElementById('root')!).render(<App />);
