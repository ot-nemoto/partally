import { Link, Navigate, Route, Routes } from "react-router-dom";
import { ParticipantLayout } from "./components/ParticipantLayout";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminLogin } from "./pages/admin/AdminLogin";
import { AdminPhotos } from "./pages/admin/AdminPhotos";
import { AdminQuizzes } from "./pages/admin/AdminQuizzes";
import { AdminRanking } from "./pages/admin/AdminRanking";
import { AdminSettings } from "./pages/admin/AdminSettings";
import { AdminTokens } from "./pages/admin/AdminTokens";
import { AdminTokensPrint } from "./pages/admin/AdminTokensPrint";
import { AdminTrend } from "./pages/admin/AdminTrend";
import { AdminUsers } from "./pages/admin/AdminUsers";
import { Gallery } from "./pages/Gallery";
import { Home } from "./pages/Home";
import { Mine } from "./pages/Mine";
import { QrLanding } from "./pages/QrLanding";
import { Quiz } from "./pages/Quiz";
import { Standings } from "./pages/Standings";

export function App() {
  return (
    <Routes>
      <Route element={<ParticipantLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/gallery" element={<Gallery />} />
        <Route path="/mine" element={<Mine />} />
        <Route path="/quiz" element={<Quiz />} />
        <Route path="/standings" element={<Standings />} />
        {/* 以前あった「お気に入り」タブ。開いたままの画面や履歴から来てもギャラリーへ */}
        <Route path="/favorites" element={<Navigate to="/gallery" replace />} />
      </Route>
      <Route path="/q/:token" element={<QrLanding />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin/tokens/print" element={<AdminTokensPrint />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminUsers />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="ranking" element={<AdminRanking />} />
        <Route path="trend" element={<AdminTrend />} />
        <Route path="tokens" element={<AdminTokens />} />
        <Route path="photos" element={<AdminPhotos />} />
        <Route path="quizzes" element={<AdminQuizzes />} />
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
