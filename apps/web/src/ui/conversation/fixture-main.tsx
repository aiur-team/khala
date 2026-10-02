import { createRoot } from 'react-dom/client';
import { ConversationFixture } from './fixture';
import '../../brand/tokens.css';
import '../khala/khala-app.css';
// The product page's remaining stylesheets (`src/main.tsx`), so the fixture lays out as the app does;
// `shell.css` still carries `.sr-only`.
import '../../shell/shell.css';
import '../../features/timeline/timeline.css';
import '../../features/channel/channel.css';
import '../../main.css';

const root = document.getElementById('fixture');
if (!root) throw new Error('missing conversation fixture mount');
createRoot(root).render(<ConversationFixture />);
