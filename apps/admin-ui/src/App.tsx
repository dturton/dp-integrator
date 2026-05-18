import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Dashboard } from '@/routes/Dashboard';
import { Orders } from '@/routes/Orders';
import { OrderDetail } from '@/routes/OrderDetail';
import { Parked } from '@/routes/Parked';
import { Reconciliation } from '@/routes/Reconciliation';

export function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/orders/:orderId" element={<OrderDetail />} />
          <Route path="/parked" element={<Parked />} />
          <Route path="/reconciliation" element={<Reconciliation />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
