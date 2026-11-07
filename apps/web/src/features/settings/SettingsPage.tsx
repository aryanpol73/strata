import { ArrowLeft, Bell, ChevronRight, Database, Info, KeyRound, LogOut, Lock, Palette, ShieldCheck, User } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import { Avatar, Button, cx } from '../../components/ui';
import { logout } from '../../state/actions';
import { useStore } from '../../state/store';
import { AboutSection, AppearanceSection, DataSection, EncryptionSection, NotificationsSection, PrivacySection, ProfileSection, SecuritySection } from './sections';

interface Entry {
  id: string;
  label: string;
  icon: ReactNode;
  Page: ComponentType;
}

const GROUPS: [string, Entry[]][] = [
  [
    'Account',
    [
      { id: 'profile', label: 'Profile', icon: <User size={18} />, Page: ProfileSection },
      { id: 'security', label: 'Account and security', icon: <ShieldCheck size={18} />, Page: SecuritySection },
      { id: 'encryption', label: 'Encryption', icon: <KeyRound size={18} />, Page: EncryptionSection },
    ],
  ],
  [
    'Preferences',
    [
      { id: 'appearance', label: 'Appearance', icon: <Palette size={18} />, Page: AppearanceSection },
      { id: 'notifications', label: 'Notifications', icon: <Bell size={18} />, Page: NotificationsSection },
      { id: 'privacy', label: 'Privacy', icon: <Lock size={18} />, Page: PrivacySection },
    ],
  ],
  [
    'App',
    [
      { id: 'data', label: 'Data and storage', icon: <Database size={18} />, Page: DataSection },
      { id: 'about', label: 'About', icon: <Info size={18} />, Page: AboutSection },
    ],
  ],
];

const ENTRIES = GROUPS.flatMap(([, entries]) => entries);

export function SettingsPage() {
  const me = useStore((s) => s.me)!;
  const { section } = useParams();
  const current = ENTRIES.find((e) => e.id === section) ?? ENTRIES[0]!;

  return (
    <div className="flex h-full">
      {/* On a phone the list is its own screen, and choosing a section replaces it. */}
      <nav aria-label="Settings sections" className={cx('scroll-thin w-full shrink-0 flex-col overflow-y-auto border-line bg-basin p-4 pb-28 lg:flex lg:w-80 lg:border-r lg:pb-4', section ? 'hidden' : 'flex')}>
        <h1 className="mb-3 text-2xl font-bold tracking-tight">You</h1>
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
          <Avatar name={me.displayName} url={me.avatarUrl} size={44} />
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{me.displayName}</p>
            <p className="truncate text-[13px] text-ink-2">@{me.handle}</p>
          </div>
        </div>
        {GROUPS.map(([group, entries]) => (
          <div key={group} className="mb-3">
            <h2 className="mb-1 px-3 text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">{group}</h2>
            {entries.map((e) => (
              <NavLink
                key={e.id}
                to={`/settings/${e.id}`}
                className={({ isActive }) => cx('st-press flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold', isActive || (!section && e === current) ? 'lg:bg-tint-violet lg:text-violet' : 'text-ink-2 hover:bg-tint-plain hover:text-ink')}
              >
                {e.icon}
                <span className="min-w-0 flex-1 truncate">{e.label}</span>
                <ChevronRight size={16} className="text-ink-3 lg:hidden" />
              </NavLink>
            ))}
          </div>
        ))}
        <Button variant="ghost" className="mt-auto justify-start" onClick={() => void logout()}>
          <LogOut size={15} /> Sign out
        </Button>
      </nav>

      <div className={cx('scroll-thin min-w-0 flex-1 overflow-y-auto pb-28 lg:block lg:pb-6', !section && 'hidden')}>
        <div className="mx-auto max-w-2xl px-4 py-4 lg:py-6">
          <Link to="/settings" className="st-press mb-3 inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-sm font-semibold text-ink-2 lg:hidden">
            <ArrowLeft size={16} /> Back to settings
          </Link>
          <current.Page />
        </div>
      </div>
    </div>
  );
}
