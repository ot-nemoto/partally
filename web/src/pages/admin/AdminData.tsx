import { ARCHIVE_MAX_BYTES, type GamesResponse, type PrizesResponse, type ScheduleResponse } from "@partally/shared";
import type { DataArchive } from "@partally/shared/data-archive";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../api";
import { PageTitle } from "../../components/PageTitle";
import { useOnReload } from "../../hooks/useReload";
import { type CurrentData, DataImportDialog } from "./data/DataImportDialog";
import { dateStamp, download } from "./data/files";
import { exportGames } from "./data/games";
import { exportPrizes } from "./data/prizes";
import { exportSchedule } from "./data/schedule";
import { exportSettings } from "./data/settings";

/** ZIP のライブラリは使うときだけ読み込む（管理画面のほかのページを重くしない） */
const loadArchive = () => import("@partally/shared/data-archive");

type Kind = "prizes" | "games" | "schedule" | "settings";

const KIND_LABEL: Record<Kind, string> = {
  prizes: "景品",
  games: "ゲーム",
  schedule: "スケジュール",
  settings: "設定",
};

/**
 * データの移行（Data）。景品・ゲーム・スケジュール・設定のうち選んだものを 1 つの ZIP に書き出し、
 * 次のイベントやリハーサル用の環境で取り込む
 */
export function AdminData() {
  const [current, setCurrent] = useState<CurrentData>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<Record<Kind, boolean>>({
    prizes: true,
    games: true,
    schedule: true,
    settings: true,
  });
  const [exporting, setExporting] = useState(false);
  const [reading, setReading] = useState(false);
  const [imported, setImported] = useState<DataArchive>();
  const [message, setMessage] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [prizes, games, schedule] = await Promise.all([
        api<PrizesResponse>("GET", "/admin/prizes"),
        api<GamesResponse>("GET", "/admin/games"),
        api<ScheduleResponse>("GET", "/admin/schedule"),
      ]);
      setCurrent({
        prizes: prizes.prizes,
        gameCount: games.games.length,
        scheduleItems: schedule.items,
        scheduleDate: schedule.date,
      });
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useOnReload(load);

  const counts: Record<Kind, number | undefined> = {
    prizes: current?.prizes.length,
    games: current?.gameCount,
    schedule: current?.scheduleItems.length,
    settings: undefined,
  };
  /** 書き出せるか（0 件の種類は書き出さない。設定はいつも書き出せる） */
  const available = (kind: Kind) => kind === "settings" || (counts[kind] ?? 0) > 0;
  const chosen = (Object.keys(KIND_LABEL) as Kind[]).filter((kind) => selected[kind] && available(kind));

  async function exportNow() {
    setExporting(true);
    setMessage(undefined);
    try {
      const { buildDataArchive } = await loadArchive();
      // 画像の署名付き URL には期限があるので、開いたままの一覧ではなく今の内容から取る
      const data: DataArchive = {
        prizes: chosen.includes("prizes") ? await exportPrizes() : undefined,
        games: chosen.includes("games") ? await exportGames() : undefined,
        schedule: chosen.includes("schedule") ? await exportSchedule() : undefined,
        settings: chosen.includes("settings") ? await exportSettings() : undefined,
      };
      const now = new Date();
      const zip = buildDataArchive(data, now.toISOString());
      download(new Blob([zip as BlobPart], { type: "application/zip" }), `partally-data-${dateStamp(now)}.zip`);
      setMessage(`${chosen.map((kind) => KIND_LABEL[kind]).join("・")}を書き出しました。`);
    } catch (e) {
      alert(`エクスポートできませんでした。${errorMessage(e)}`);
    } finally {
      setExporting(false);
    }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setMessage(undefined);
    // 間違えて大きなファイルを選んでも画面が固まらないよう、読む前に大きさを確かめる
    if (file.size > ARCHIVE_MAX_BYTES) {
      alert(`このファイルは取り込めません。\nファイルが大きすぎます（${ARCHIVE_MAX_BYTES / 1024 / 1024}MB まで）。`);
      return;
    }
    setReading(true);
    try {
      const { readDataArchive } = await loadArchive();
      const result = readDataArchive(new Uint8Array(await file.arrayBuffer()));
      if (result.ok) setImported(result.data);
      else alert(`このファイルは取り込めません。\n${result.error}`);
    } catch (e) {
      alert(`ファイルを読めませんでした。${errorMessage(e)}`);
    } finally {
      setReading(false);
    }
  }

  return (
    <section className="admin-data">
      <PageTitle en="Data" ja="データの移行" />
      <p className="muted small">
        景品・ゲーム・スケジュール・設定を 1 つの ZIP
        ファイルに書き出し、次のイベント（データを消した後）やリハーサル用の環境で取り込めます。
      </p>
      {error && <p className="error">{error}</p>}

      <div className="card data-card">
        <h2>エクスポート</h2>
        <p className="muted small">書き出すものを選んでください。</p>
        <div className="data-kinds">
          {(Object.keys(KIND_LABEL) as Kind[]).map((kind) => (
            <label key={kind} className="import-option">
              <input
                type="checkbox"
                checked={selected[kind] && available(kind)}
                disabled={!current || !available(kind) || exporting}
                onChange={(e) => setSelected({ ...selected, [kind]: e.target.checked })}
              />
              <span>
                {KIND_LABEL[kind]}
                {counts[kind] !== undefined && <span className="muted">（{counts[kind]} 件）</span>}
              </span>
            </label>
          ))}
        </div>
        <p className="muted small">
          ゲームは作り直すのに要るもの（形式・名前・説明・画像・選択肢・枠・点数の範囲・正解の数・合言葉など）を入れ、開催・確定の状態、答え、抽選の順番、結果入力の枠に選んだ人は入れません。
        </p>
        <div className="buttons">
          <button
            type="button"
            className="primary"
            onClick={exportNow}
            disabled={exporting || !current || chosen.length === 0}
          >
            {exporting ? "書き出し中…" : "エクスポート"}
          </button>
        </div>
      </div>

      <div className="card data-card">
        <h2>インポート</h2>
        <p className="muted small">
          エクスポートした ZIP を選ぶと、中身を見て、取り込むものと取り込み方（追加か置き換えか）を選べます。
          以前に景品・ゲーム・スケジュールの画面で書き出したファイル（ZIP・JSON）も取り込めます。
        </p>
        <div className="buttons">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={reading || !current}>
            {reading ? "読み込み中…" : "ファイルを選ぶ"}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          hidden
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {message && <p className="small">{message}</p>}

      {imported && current && (
        <DataImportDialog
          data={imported}
          current={current}
          onClose={() => setImported(undefined)}
          onDone={() => {
            setImported(undefined);
            setMessage("取り込みました。");
            void load();
          }}
        />
      )}
    </section>
  );
}
