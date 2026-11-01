import { createRoot } from 'react-dom/client';
import { AudioEngine } from '../audio/engine';
import type { AudioCommand } from '../../../shared/types';
import { Overlay } from './Overlay';
import '../styles/overlay.css';

// One audio engine for the whole app, owned by the overlay window.
const engine = new AudioEngine();
window.jarvis.on('audio:cmd', (cmd) => engine.handle(cmd as AudioCommand));

createRoot(document.getElementById('root')!).render(<Overlay engine={engine} />);
