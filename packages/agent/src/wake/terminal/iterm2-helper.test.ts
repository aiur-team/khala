import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { iterm2ScriptPath } from './iterm2';
it('runs Python guard against a styled mock API, including changed drafts and broadcast suppression', () => {
 const script = `
import asyncio, importlib.util, sys, types
spec = importlib.util.spec_from_file_location('helper', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
class Line:
    string = '› '
    def string_at(self, x): return self.string[x]
    def style_at(self, x): return types.SimpleNamespace(faint=False)
class Session:
    grid_size = types.SimpleNamespace(width=80)
    sent = []
    line = Line()
    async def async_get_screen_contents(self):
        return types.SimpleNamespace(cursor_coord=types.SimpleNamespace(x=2,y=101), number_of_lines=3,
            windowed_coord_range=types.SimpleNamespace(coord_range=types.SimpleNamespace(start=types.SimpleNamespace(y=100))),
            line=lambda row: self.line if row == 1 else None)
    async def async_get_variable(self, name):
        assert name == 'tty'
        return '/dev/ttys001'
    async def async_send_text(self, text, suppress_broadcast):
        assert suppress_broadcast is True
        self.sent.append(text)
session = Session()
async def get_app(connection): return types.SimpleNamespace(get_session_by_id=lambda uuid: session if uuid == 'uuid' else None)
sys.modules['iterm2'] = types.SimpleNamespace(async_get_app=get_app)
async def test():
    assert await helper.operate(None, 'missing') == {'reason':'iterm2_session_missing'}
    view = await helper.operate(None, 'uuid')
    assert view['line'] == '\\x1b[22m›\\x1b[22m '
    assert await helper.operate(None, 'uuid', 'fixed', view) == {'status':'sent'}
    session.line.string = '› draft'
    assert await helper.operate(None, 'uuid', '\\r', view) == {'status':'not_empty'}
    assert session.sent == ['fixed']
    session.line.string = '› Ask Codex to do anything'
    session.line.style_at = lambda x: types.SimpleNamespace(faint=x >= 2)
    styled = await helper.operate(None, 'uuid')
    assert '\\x1b[2mA' in styled['line']
asyncio.run(test())
print('ok')
`;
 expect(execFileSync('python3', ['-c', script, iterm2ScriptPath()], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim()).toBe('ok');
});
