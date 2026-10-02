import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UsernameFields, UsernameForm, submitUsername, type UsernameFieldsProps } from './UsernameForm';
import { ProfileStoreProvider, type ProfileSaveResult } from './ProfileProvider';
import { createProfileStore } from './store';

function fields(value: string, props: Partial<UsernameFieldsProps> = {}) {
  return renderToStaticMarkup(<UsernameFields value={value} submitLabel="Continue" saving={false} error={null}
    onChange={vi.fn()} onSubmit={vi.fn()} {...props} />);
}
const submitDisabled = (html: string) => /<button type="submit" class="kh-btn pri" disabled="">/.test(html);

describe('UsernameForm', () => {
  it('shows the initial suggestion', () => {
    const html = renderToStaticMarkup(<ProfileStoreProvider store={createProfileStore(undefined)}>
      <UsernameForm initial="kevin42" submitLabel="Continue" onSaved={vi.fn()} />
    </ProfileStoreProvider>);
    expect(html).toContain('value="kevin42"');
    expect(html).toContain('aria-label="Username"');
    expect(html).toContain('maxLength="24"');
    expect(html).toContain('autoComplete="nickname"');
    expect(html).toContain('2–24 letters, numbers, . _ or -');
    expect(submitDisabled(html)).toBe(false);
  });

  it('announces a too-short name and disables submit', () => {
    const html = fields('a');
    expect(html).toContain('role="alert">At least 2 characters.</p>');
    expect(submitDisabled(html)).toBe(true);
  });

  it('rejects a name that collides with the agent naming rule', () => {
    const html = fields('Kevin-Claude');
    expect(html).toMatch(/role="alert">(That name is reserved\.|Use letters, numbers, \. _ or -, starting and ending with a letter or number\.)<\/p>/);
    expect(submitDisabled(html)).toBe(true);
  });

  it('words each name rule', () => {
    expect(fields('a'.repeat(25))).toContain('At most 24 characters.');
    expect(fields('-kevin')).toContain('Use letters, numbers, . _ or -, starting and ending with a letter or number.');
  });

  it('disables submit while saving', () => {
    const html = fields('Kevin', { saving: true });
    expect(submitDisabled(html)).toBe(true);
    expect(html).toContain('Saving…');
  });

  it('previews the agent names as the value changes', () => {
    expect(fields('Kevin')).toContain('Your agents will be named @Kevin-Claude and @Kevin-Codex.');
    expect(fields('Ana')).toContain('Your agents will be named @Ana-Claude and @Ana-Codex.');
    expect(fields('')).not.toContain('Your agents will be named');
  });

  it('shows a save error until the value changes', () => {
    expect(fields('Kevin', { error: 'That username is taken.' })).toContain('role="alert">That username is taken.</p>');
  });
});

describe('submitUsername', () => {
  const saving = (result: ProfileSaveResult) => vi.fn<(username: string) => Promise<ProfileSaveResult>>(async () => result);

  it('saves a valid name and reports it', async () => {
    const save = saving({ kind: 'ok', username: 'Kevin' });
    expect(await submitUsername('Kevin', save)).toEqual({ kind: 'saved', username: 'Kevin' });
    expect(save).toHaveBeenCalledWith('Kevin');
  });

  it('calls onSaved with the saved name', async () => {
    const onSaved = vi.fn();
    const store = createProfileStore({ get: vi.fn(), setUsername: async username => ({ kind: 'ok', username }) });
    const result = await submitUsername('Kevin', store.save);
    if (result.kind === 'saved') onSaved(result.username);
    expect(onSaved).toHaveBeenCalledWith('Kevin');
  });

  it('words a taken name', async () => {
    expect(await submitUsername('Kevin', saving({ kind: 'error', code: 'username_taken' })))
      .toEqual({ kind: 'error', message: 'That username is taken.' });
  });

  it('words an unavailable save, a thrown save and a server name rule', async () => {
    const retry = { kind: 'error', message: 'Couldn\'t save. Try again.' };
    expect(await submitUsername('Kevin', saving({ kind: 'error', code: 'unavailable' }))).toEqual(retry);
    expect(await submitUsername('Kevin', async () => { throw new Error('offline'); })).toEqual(retry);
    expect(await submitUsername('Kevin', saving({ kind: 'error', code: 'invalid_username', reason: 'reserved' })))
      .toEqual({ kind: 'error', message: 'That name is reserved.' });
  });

  it('never saves an invalid name', async () => {
    const save = saving({ kind: 'ok', username: 'a' });
    expect(await submitUsername('a', save)).toEqual({ kind: 'error', message: 'At least 2 characters.' });
    expect(save).not.toHaveBeenCalled();
  });
});
