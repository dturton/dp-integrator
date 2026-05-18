import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, ListOrdered, ParkingCircle, Plug, Scale } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Two-pane app layout — left rail nav, content on the right. Single-line
 * top bar shows the environment + build label so an operator looking at a
 * screenshot always knows which env they're in.
 */
export function AppLayout(): React.ReactElement {
  return (
    <div className="flex h-full">
      <aside className="flex w-56 flex-col border-r bg-card">
        <div className="flex h-14 items-center border-b px-4 text-sm font-semibold">
          dpi admin
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          <NavItem to="/" icon={<LayoutDashboard className="h-4 w-4" />} label="Dashboard" end />
          <NavItem to="/orders" icon={<ListOrdered className="h-4 w-4" />} label="Orders" />
          <NavItem to="/parked" icon={<ParkingCircle className="h-4 w-4" />} label="Parked" />
          <NavItem to="/reconciliation" icon={<Scale className="h-4 w-4" />} label="Reconciliation" />
          <NavItem to="/connections" icon={<Plug className="h-4 w-4" />} label="Connections" />
        </nav>
        <div className="border-t p-3 text-xs text-muted-foreground">
          <div>env: dev</div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean | undefined;
}

function NavItem({ to, icon, label, end }: NavItemProps): React.ReactElement {
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
