import { Lock, LogOut } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input } from '../../components/ui';
import { logout } from '../../state/actions';
import { setupE2ee, resetE2ee, unlockE2ee, useE2ee } from './service';

const MIN_LENGTH = 10;

/**
 * Stands in front of the app until encryption is set up, because a conversation can't be end-to-end encrypted for
 * someone who has no key. Setting up takes one passphrase, once. Signing in somewhere new takes the same passphrase.
 */
export function E2eeGate() {
  const status = useE2ee((s) => s.status);
  const dismissed = useE2ee((s) => s.unlockDismissed);
  if (status === 'needs-setup') return <Panel mode="setup" />;
  if (status === 'locked' && !dismissed) return <Panel mode="unlock" />;
  return null;
}

function Panel({ mode }: { mode: 'setup' | 'unlock' }) {
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const creating = mode === 'setup' || forgot;
  const problem = creating ? (passphrase.length < MIN_LENGTH ? `Use at least ${MIN_LENGTH} characters.` : passphrase !== again ? 'These two don\'t match yet.' : null) : passphrase ? null : 'Enter your passphrase.';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      if (forgot) await resetE2ee(passphrase);
      else if (mode === 'setup') await setupE2ee(passphrase);
      else await unlockE2ee(passphrase);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(false);
    }
  };

  const title = forgot ? 'Start over with new keys' : mode === 'setup' ? 'Protect your conversations' : 'Unlock your messages';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-scrim p-4 backdrop-blur-sm">
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="e2ee-title" className="st-glass my-auto w-full max-w-md rounded-[28px] p-6 shadow-float animate-rise">
        <span className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-tint-violet text-violet">
          <Lock size={20} />
        </span>
        <h2 id="e2ee-title" className="text-xl font-bold tracking-tight">
          {title}
        </h2>

        {forgot ? (
          <p className="mt-2 text-sm text-ink-2">
            Without your passphrase, your old encrypted messages can't be opened on this device. Strata can't recover it for you. New keys let you keep using Strata, and the
            other people in a conversation can share its history with you again when they next open it.
          </p>
        ) : mode === 'setup' ? (
          <p className="mt-2 text-sm text-ink-2">
            Strata encrypts your messages on this device before they're sent. Only the people in a conversation can read them, not the server. Choose a passphrase to protect your
            encryption key. You'll enter it when you sign in on a new device.
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-2">Enter your encryption passphrase to read and send messages on this device. It never leaves your browser.</p>
        )}

        <div className="mt-4 space-y-3">
          <Field label="Encryption passphrase">
            <Input type="password" autoComplete={creating ? 'new-password' : 'current-password'} autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
          {creating && (
            <Field label="Repeat passphrase">
              <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </Field>
          )}
        </div>

        {creating && !forgot && (
          <p className="mt-3 rounded-xl bg-tint-crystal p-2.5 text-[13px] text-ink-2">
            Strata can't reset this passphrase. If you forget it and sign out everywhere, older encrypted messages can't be recovered. A password manager is a good place to keep it.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-alert">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" busy={busy} className="mt-4 w-full">
          {forgot ? 'Reset encryption keys' : mode === 'setup' ? 'Set up encryption' : 'Unlock'}
        </Button>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
          {mode === 'unlock' && (
            <button
              type="button"
              className="font-semibold text-ink-2 underline-offset-2 hover:underline"
              onClick={() => {
                setForgot(!forgot);
                setError(null);
              }}
            >
              {forgot ? 'I remember it' : 'Forgot your passphrase?'}
            </button>
          )}
          {mode === 'unlock' && (
            <button type="button" className="font-semibold text-ink-2 underline-offset-2 hover:underline" onClick={() => useE2ee.setState({ unlockDismissed: true })}>
              Not now
            </button>
          )}
          <button type="button" className="ml-auto inline-flex items-center gap-1 font-semibold text-ink-2 underline-offset-2 hover:underline" onClick={() => void logout()}>
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </form>
    </div>
  );
}
