interface InstallPrompt extends Event {
  prompt(): Promise<void>;
}

let installPrompt: InstallPrompt | null = null;

/** Starts at launch, because the browser offers this once and may do it before Settings has loaded. */
export function watchInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e as InstallPrompt;
  });
}

export const hasInstallPrompt = () => installPrompt !== null;

export function offerInstall() {
  void installPrompt?.prompt();
  installPrompt = null;
}
