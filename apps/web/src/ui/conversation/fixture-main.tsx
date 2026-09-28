import { createRoot } from 'react-dom/client';
import { ConversationFixture } from './fixture';
import '../../brand/tokens.css';
import '../../shell/shell.css';

const root = document.getElementById('fixture');
if (!root) throw new Error('missing conversation fixture mount');
createRoot(root).render(<ConversationFixture />);
