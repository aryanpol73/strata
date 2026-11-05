import { useState, type FormEvent } from 'react';
import { Button, Field, Input } from '../../components/ui';
import { login, register } from '../../state/actions';
import { Wordmark } from '../shell/AppShell';

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', displayName: '', handle: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(form.email, form.password);
      else await register(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-sheet p-12 lg:flex">
        <Wordmark size={26} />
        <div className="max-w-md">
          <h1 className="font-serif text-5xl leading-[1.08] font-medium">Conversations should crystallize, not evaporate.</h1>
          <p className="mt-5 text-lg text-ink-2">Branch a side discussion, merge its outcome, and keep what your group decides somewhere it stays useful.</p>
        </div>
        <svg viewBox="0 0 600 120" className="absolute right-0 bottom-0 left-0 w-full opacity-70" aria-hidden preserveAspectRatio="none">
          <path d="M0 40c90-30 170 26 280 4s190-30 320-6" fill="none" stroke="var(--line-strong)" strokeWidth="1.5" />
          <path d="M0 66c100-26 180 24 290 6s180-26 310-8" fill="none" stroke="var(--copper)" strokeWidth="1.5" />
          <path d="M0 92c110-22 190 22 300 8s170-22 300-10" fill="none" stroke="var(--vein)" strokeWidth="1.5" />
        </svg>
        <span />
      </section>
      <main className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-3.5">
          <div className="mb-6 lg:hidden">
            <Wordmark size={24} />
          </div>
          <h2 className="font-serif text-2xl font-medium">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
          {mode === 'register' && (
            <>
              <Field label="Your name">
                <Input required value={form.displayName} onChange={set('displayName')} autoComplete="name" />
              </Field>
              <Field label="Handle" hint="How people find you. Letters, numbers and underscores.">
                <Input required pattern="[A-Za-z0-9_]{3,24}" value={form.handle} onChange={set('handle')} autoComplete="username" />
              </Field>
            </>
          )}
          <Field label="Email">
            <Input required type="email" value={form.email} onChange={set('email')} autoComplete="email" />
          </Field>
          <Field label="Password" hint={mode === 'register' ? 'At least 10 characters.' : undefined}>
            <Input required type="password" minLength={mode === 'register' ? 10 : 1} value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </Field>
          {error && (
            <p role="alert" className="rounded-lg bg-oxide-soft px-3 py-2 text-sm text-oxide">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={busy} className="h-10 w-full">
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
          <p className="text-center text-sm text-ink-2">
            {mode === 'login' ? 'New here?' : 'Already have an account?'}{' '}
            <button
              type="button"
              className="font-medium text-vein underline underline-offset-2"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError(null);
              }}
            >
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </form>
      </main>
    </div>
  );
}
