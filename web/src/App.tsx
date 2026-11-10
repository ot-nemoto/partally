import { Link, Navigate, Route, Routes } from "react-router-dom";
import { ParticipantLayout } from "./components/ParticipantLayout";
import { AdminGames } from "./pages/admin/AdminGames";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminLogin } from "./pages/admin/AdminLogin";
import { AdminPhotos } from "./pages/admin/AdminPhotos";
import { AdminPrizes } from "./pages/admin/AdminPrizes";
import { AdminRanking } from "./pages/admin/AdminRanking";
import { AdminSchedule } from "./pages/admin/AdminSchedule";
import { AdminSettings } from "./pages/admin/AdminSettings";
import { AdminTokens } from "./pages/admin/AdminTokens";
import { AdminTokensPrint } from "./pages/admin/AdminTokensPrint";
import { AdminTrend } from "./pages/admin/AdminTrend";
import { AdminUsers } from "./pages/admin/AdminUsers";
import { Gallery } from "./pages/Gallery";
import { Game } from "./pages/Game";
import { Home } from "./pages/Home";
import { Mine } from "./pages/Mine";
import { QrLanding } from "./pages/QrLanding";
import { Standings } from "./pages/Standings";

export function App() {
  return (
    <Routes>
      <Route element={<ParticipantLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/gallery" element={<Gallery />} />
        <Route path="/mine" element={<Mine />} />
        <Route path="/game" element={<Game />} />
        {/* 以前あったクイズの画面。開いたままの画面や履歴から来てもゲームへ */}
        <Route path="/quiz" element={<Navigate to="/game" replace />} />
        <Route path="/standings" element={<Standings />} />
        {/* 以前あった「お気に入り」タブ。開いたままの画面や履歴から来てもギャラリーへ */}
        <Route path="/favorites" element={<Navigate to="/gallery" replace />} />
      </Route>
      <Route path="/q/:token" element={<QrLanding />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin/tokens/print" element={<AdminTokensPrint />} />
      <Route path="/admin" element={<AdminLayout />}>
        {/* User 画面のヘッダーのリンク（/admin/users）が選択状態になるよう、URL を移す */}
        <Route index element={<Navigate to="users" replace />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="ranking" element={<AdminRanking />} />
        <Route path="trend" element={<AdminTrend />} />
        <Route path="tokens" element={<AdminTokens />} />
        <Route path="photos" element={<AdminPhotos />} />
        <Route path="quizzes" element={<Navigate to="/admin/games" replace />} />
        <Route path="games" element={<AdminGames />} />
        <Route path="prizes" element={<AdminPrizes />} />
        <Route path="schedule" element={<AdminSchedule />} />
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
