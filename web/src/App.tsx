import { Link, Route, Routes } from "react-router-dom";
import { ParticipantLayout } from "./components/ParticipantLayout";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminLogin } from "./pages/admin/AdminLogin";
import { AdminPhotos } from "./pages/admin/AdminPhotos";
import { AdminSettings } from "./pages/admin/AdminSettings";
import { AdminTokens } from "./pages/admin/AdminTokens";
import { AdminTokensPrint } from "./pages/admin/AdminTokensPrint";
import { AdminUsers } from "./pages/admin/AdminUsers";
import { Gallery } from "./pages/Gallery";
import { Home } from "./pages/Home";
import { Mine } from "./pages/Mine";
import { QrLanding } from "./pages/QrLanding";

export function App() {
  return (
    <Routes>
      <Route element={<ParticipantLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/gallery" element={<Gallery key="view" />} />
        <Route path="/favorites" element={<Gallery mode="favorite" key="favorite" />} />
        <Route path="/mine" element={<Mine />} />
      </Route>
      <Route path="/q/:token" element={<QrLanding />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin/tokens/print" element={<AdminTokensPrint />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminUsers />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="tokens" element={<AdminTokens />} />
        <Route path="photos" element={<AdminPhotos />} />
        <Route path="settings" element={<AdminSettings />} />
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
