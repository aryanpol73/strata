import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Spinner } from './components/ui';
import { E2eeGate } from './features/e2ee/E2eeGate';
import { useE2ee } from './features/e2ee/service';
import { AuthPage } from './features/auth/AuthPage';
import { rejoinAll } from './features/blocks/blockSession';
import { AppShell, HomeEmpty, Wordmark } from './features/shell/AppShell';
import { onConnected } from './realtime/socket';
import { bootstrap } from './state/actions';
import { useStore } from './state/store';

const RoomPage = lazy(() => import('./features/chat/RoomPage').then((m) => ({ default: m.RoomPage })));
const AttentionPage = lazy(() => import('./features/attention/AttentionPage').then((m) => ({ default: m.AttentionPage })));
const BranchesPage = lazy(() => import('./features/branches/BranchesPage').then((m) => ({ default: m.BranchesPage })));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));

const Pane = ({ children }: { children: React.ReactNode }) => (
  <Suspense
    fallback={
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    }
  >
    {children}
  </Suspense>
);

export function Member() {
  const status = useStore((s) => s.authStatus);
  const e2ee = useE2ee((s) => s.status);

  useEffect(() => {
    void bootstrap();
    return onConnected(rejoinAll) as () => void;
  }, []);

  if (status === 'loading') {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4">
        <Wordmark size={26} />
        <Spinner />
      </div>
    );
  }
  if (status === 'anon') return <AuthPage />;
  if (e2ee === 'idle' || e2ee === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <>
    <E2eeGate />
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeEmpty />} />
        <Route path="r/:roomId" element={<Pane><RoomPage /></Pane>} />
        <Route path="branches" element={<Pane><BranchesPage /></Pane>} />
        <Route path="attention" element={<Pane><AttentionPage /></Pane>} />
        <Route path="settings/:section?" element={<Pane><SettingsPage /></Pane>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </>
  );
}
