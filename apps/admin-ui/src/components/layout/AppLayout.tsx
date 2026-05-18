import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, ListOrdered, ParkingCircle, Plug, Scale } from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/orders', icon: ListOrdered, label: 'Orders' },
  { to: '/parked', icon: ParkingCircle, label: 'Parked' },
  { to: '/reconciliation', icon: Scale, label: 'Recon' },
  { to: '/connections', icon: Plug, label: 'Conns' },
] as const;

/**
 * Responsive layout. md+ shows the classic left rail nav with the content
 * on the right. Below md (phones, narrow tablets) the rail collapses into
 * a bottom-tab bar and the content takes the full width.
 */
export function AppLayout(): React.ReactElement {
  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Desktop sidebar — hidden on phones */}
      <aside className="hidden w-56 flex-col border-r bg-card md:flex">
        <div className="flex h-14 items-center border-b px-4 text-sm font-semibold">
          dpi admin
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV_ITEMS.map((item) => (
            <SideNavItem
              key={item.to}
              to={item.to}
              icon={<item.icon className="h-4 w-4" />}
              label={item.label === 'Recon' ? 'Reconciliation' : item.label === 'Conns' ? 'Connections' : item.label}
              end={'end' in item ? item.end : undefined}
            />
          ))}
        </nav>
        <div className="border-t p-3 text-xs text-muted-foreground">
          <div>env: dev</div>
        </div>
      </aside>

      {/* Mobile header bar — visible only on phones */}
      <header className="flex h-12 items-center justify-between border-b bg-card px-4 md:hidden">
        <div className="text-sm font-semibold">dpi admin</div>
        <div className="text-xs text-muted-foreground">env: dev</div>
      </header>

      {/* Content. pb on mobile leaves room for the fixed bottom nav. */}
      <main className="flex-1 overflow-auto pb-16 md:pb-0">
        <Outlet />
      </main>

      {/* Mobile bottom-tab nav — visible only on phones */}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex h-16 items-stretch border-t bg-card md:hidden">
        {NAV_ITEMS.map((item) => (
          <BottomNavItem
            key={item.to}
            to={item.to}
            icon={<item.icon className="h-5 w-5" />}
            label={item.label}
            end={'end' in item ? item.end : undefined}
          />
        ))}
      </nav>
    </div>
  );
}

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean | undefined;
}

function SideNavItem({ to, icon, label, end }: NavItemProps): React.ReactElement {
  return (
    <NavLink
      to={to}
      {...(end !== undefined ? { end } : {})}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
          isActive
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

function BottomNavItem({ to, icon, label, end }: NavItemProps): React.ReactElement {
  return (
    <NavLink
      to={to}
      {...(end !== undefined ? { end } : {})}
      className={({ isActive }) =>
        cn(
          'flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors',
          isActive
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
