import { Navigate, Outlet } from 'react-router-dom';
import { useIdentity } from '../lib/identity';

/** Route guard: admins see the nested routes, members are sent elsewhere. The server refuses their calls anyway. */
export function AdminOnly({ to = '/settings/account' }: { to?: string }) {
  const { isAdmin } = useIdentity();
  return isAdmin ? <Outlet /> : <Navigate to={to} replace />;
}
