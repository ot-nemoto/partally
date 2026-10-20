import { Link, Route, Routes } from "react-router-dom";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminLogin } from "./pages/admin/AdminLogin";
import { AdminTokens } from "./pages/admin/AdminTokens";
import { AdminTokensPrint } from "./pages/admin/AdminTokensPrint";
import { AdminUsers } from "./pages/admin/AdminUsers";
import { Home } from "./pages/Home";
import { QrLanding } from "./pages/QrLanding";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/q/:token" element={<QrLanding />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin/tokens/print" element={<AdminTokensPrint />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminUsers />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="tokens" element={<AdminTokens />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function NotFound() {
  return (
    <main className="page">
      <p>ページが見つかりません。</p>
      <Link to="/">トップへ</Link>
    </main>
  );
}
