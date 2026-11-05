import { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Spinner, cx } from './components/ui';
import { useStore } from './state/store';

// Split by audience: a guest never downloads the member app, and a member's first paint doesn't wait for the rest.
const Member = lazy(() => import('./Member').then((m) => ({ default: m.Member })));
const GuestPage = lazy(() => import('./features/guest/GuestPage').then((m) => ({ default: m.GuestPage })));

const Loading = () => (
  <div className="flex h-dvh items-center justify-center">
    <Spinner />
  </div>
);

function Toast() {
  const toast = useStore((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 3600);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast || !visible) return null;
  return (
    <div role="status" className={cx('fixed top-3 left-1/2 z-[60] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg px-3.5 py-2 text-sm shadow-float animate-settle', toast.tone === 'error' ? 'bg-alert text-on-alert' : 'bg-raised text-ink border border-line-strong')}>
      {toast.text}
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
        <Routes>
          {/* The guest page never loads member state, so a guest's browser never holds any. */}
          <Route path="/g" element={<GuestPage />} />
          <Route path="*" element={<Member />} />
        </Routes>
      </Suspense>
      <Toast />
    </BrowserRouter>
  );
}
