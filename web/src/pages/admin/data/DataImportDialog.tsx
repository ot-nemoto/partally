import type { PrizeDto, ScheduleItemDto } from "@partally/shared";
import type { DataArchive } from "@partally/shared/data-archive";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, api, errorMessage } from "../../../api";
import { confirmDialog } from "../../../components/ConfirmDialog";
import { Modal } from "../../../components/Modal";
import { useT } from "../../../i18n";
import { GamePreview, importGame, importRounds } from "./games";
import { importPrize, PrizePreview } from "./prizes";
import { importScheduleItem, SchedulePreview } from "./schedule";
import { SettingsPreview, saveSettings } from "./settings";

type Mode = "add" | "replace";

/** 今あるもの（置き換えで消すもの・件数の表示に使う） */
export interface CurrentData {
  prizes: PrizeDto[];
  gameCount: number;
  scheduleItems: ScheduleItemDto[];
  scheduleDate: string;
}

/**
 * 取り込みの画面。ファイルに入っている種類ごとに中身を見せ、取り込むものと取り込み方を選んでから、
 * ゲーム → 景品 → スケジュール → 設定の順に 1 件ずつ取り込む。
 * 置き換えは、その種類をすべて取り込めてから今のものを消す（途中で失敗しても、今のものが無くならないように）
 */
export function DataImportDialog(props: {
  data: DataArchive;
  current: CurrentData;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { data, current } = props;
  const [include, setInclude] = useState({
    prizes: !!data.prizes,
    games: !!data.games,
    schedule: !!data.schedule,
    // 設定は写真の公開方法や参加者への公開まで変わるので、選んだときだけ取り込む
    settings: false,
  });
  const [prizeMode, setPrizeMode] = useState<Mode>("add");
  const [scheduleMode, setScheduleMode] = useState<Mode>("add");
  const [withDate, setWithDate] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const locked = running || finished;

  // 取り込みは画面から 1 件ずつ送るので、途中でタブを閉じたり読み込み直したりすると、途中まで作った状態で止まり、
  // どこまで終わったかも出ない。件数が多いと長くかかるので、取り込んでいる間は離れる前にブラウザに確かめさせる
  useEffect(() => {
    if (!running) return;
    const confirmLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // preventDefault() だけでは確かめない、古いブラウザ向け
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", confirmLeave);
    return () => window.removeEventListener("beforeunload", confirmLeave);
  }, [running]);
  const nothing = !Object.values(include).some(Boolean);

  async function run() {
    const removing = [
      include.prizes &&
        prizeMode === "replace" &&
        current.prizes.length > 0 &&
        t(
          `景品 ${current.prizes.length} 件`,
          current.prizes.length === 1 ? "1 prize" : `${current.prizes.length} prizes`,
        ),
      include.schedule &&
        scheduleMode === "replace" &&
        current.scheduleItems.length > 0 &&
        t(
          `スケジュールの項目 ${current.scheduleItems.length} 件`,
          current.scheduleItems.length === 1 ? "1 schedule item" : `${current.scheduleItems.length} schedule items`,
        ),
    ].filter(Boolean);
    const notes = [
      removing.length > 0 &&
        t(
          `今の${removing.join("・")}を削除し、取り込んだものに置き換えます。`,
          `The current ${removing.join(" and ")} will be deleted and replaced with the imported ones.`,
        ),
      include.settings &&
        t("設定は、取り込んだ内容に置き換わります。", "Settings will be replaced with the imported ones."),
    ].filter(Boolean);
    if (
      notes.length > 0 &&
      !(await confirmDialog(t(`${notes.join("\n")}\nよろしいですか？`, `${notes.join("\n")}\nContinue?`)))
    )
      return;

    setRunning(true);
    setError(undefined);
    /** 今していること（止まったときの表示に使う） */
    let doing = "";
    /** 置き換えで、今のものを消している途中か（止まったときに、残っている分があると知らせる） */
    let removingNow = false;
    const done: string[] = [];
    /** items を 1 件ずつ取り込む。置き換えのときは、取り込めてから今のものを消す（ほかの画面で消されていたら飛ばす） */
    async function step<T>(
      [label, labelEn, singular]: [ja: string, en: string, enSingular: string],
      items: T[],
      nameOf: (item: T) => string,
      importOne: (item: T) => Promise<void>,
      removers: (() => Promise<unknown>)[] = [],
    ) {
      for (const [i, item] of items.entries()) {
        doing = t(`${label}の ${i + 1} 件目（${nameOf(item)}）`, `${labelEn} item ${i + 1} (${nameOf(item)})`);
        setProgress(
          t(
            `${label}を取り込み中… ${i + 1} / ${items.length}`,
            `Importing ${labelEn.toLowerCase()}… ${i + 1} / ${items.length}`,
          ),
        );
        await importOne(item);
      }
      removingNow = removers.length > 0;
      for (const [i, remove] of removers.entries()) {
        doing = t(`今の${label}の削除`, `deleting the current ${labelEn.toLowerCase()}`);
        setProgress(
          t(
            `今の${label}を削除中… ${i + 1} / ${removers.length}`,
            `Deleting the current ${labelEn.toLowerCase()}… ${i + 1} / ${removers.length}`,
          ),
        );
        try {
          await remove();
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
      }
      removingNow = false;
      done.push(
        t(`${label} ${items.length} 件`, `${items.length} ${(items.length === 1 ? singular : labelEn).toLowerCase()}`),
      );
    }
    try {
      if (include.games && data.games) {
        // 作ったゲームの ID を覚え、ファイルのラウンドを作り直す
        const ids: string[] = [];
        await step(
          ["ゲーム", "Games", "Game"],
          data.games,
          (g) => g.name,
          async (g) => {
            ids.push(await importGame(g));
          },
        );
        if (data.games.some((g) => g.round)) {
          doing = t("ラウンドの作成", "creating rounds");
          setProgress(t("ラウンドを作成中…", "Creating rounds…"));
          const created = await importRounds(data.games, ids);
          done.push(t(`ラウンド ${created} 件`, `${created} ${created === 1 ? "round" : "rounds"}`));
        }
      }
      if (include.prizes && data.prizes) {
        const removers =
          prizeMode === "replace" ? current.prizes.map((p) => () => api("DELETE", `/admin/prizes/${p.prizeId}`)) : [];
        await step(["景品", "Prizes", "Prize"], data.prizes, (p) => p.name, importPrize, removers);
      }
      if (include.schedule && data.schedule) {
        const removers =
          scheduleMode === "replace"
            ? current.scheduleItems.map((item) => () => api("DELETE", `/admin/schedule/${item.itemId}`))
            : [];
        // 取り込む項目は、今の列の右に、ファイルの列の並びのまま置く（今の項目と重ならないように）。
        // 置き換えなら、今の項目を消すと左の列が詰まり、ファイルのとおりの列になる。
        // 左の列から順に作る（列を左から埋めないと、作るたびに空いた列が詰められて、置いた列がずれる）
        const offset =
          current.scheduleItems.length > 0 ? Math.max(...current.scheduleItems.map((i) => i.column)) + 1 : 0;
        const ordered = [...data.schedule.items]
          .sort((a, b) => (a.column ?? 0) - (b.column ?? 0) || a.startMinute - b.startMinute)
          .map((item) => ({ ...item, column: (item.column ?? 0) + offset }));
        await step(
          ["スケジュール", "Schedule items", "Schedule item"],
          ordered,
          (item) => item.title,
          importScheduleItem,
          removers,
        );
      }
      const date = include.schedule && withDate ? data.schedule?.date : undefined;
      if ((include.settings && data.settings) || date) {
        doing = t("設定の保存", "saving settings");
        setProgress(t("設定を保存中…", "Saving settings…"));
        await saveSettings({ settings: include.settings ? data.settings : undefined, scheduleDate: date });
      }
      props.onDone();
    } catch (e) {
      const before =
        done.length > 0 ? t(`（${done.join("・")}は取り込み済み）`, ` (already imported: ${done.join(", ")})`) : "";
      const left = removingNow
        ? t("今のもののうち、まだ消していない分は残っています。", "Current items not yet deleted are still there. ")
        : "";
      setError(
        t(
          `${doing}で止まりました${before}。${left}${errorMessage(e)}`,
          `Stopped at ${doing}${before}. ${left}${errorMessage(e)}`,
        ),
      );
      setFinished(true);
    } finally {
      setRunning(false);
      setProgress(undefined);
    }
  }

  return (
    <Modal
      className="dialog import-dialog"
      label={t("インポート", "Import")}
      onClose={props.onClose}
      closable={!running}
    >
      <div className="card">
        <h2>{t("インポート", "Import")}</h2>
        <p className="small">
          {t(
            "取り込むものを選んでください。上から順に取り込みます。",
            "Choose what to import. Items are imported from the top.",
          )}
        </p>
        {data.games && (
          <Section
            title={t(`ゲーム（${data.games.length} 件）`, `Games (${data.games.length})`)}
            checked={include.games}
            onCheck={(v) => setInclude({ ...include, games: v })}
            disabled={locked}
            preview={<GamePreview items={data.games} />}
          >
            <p className="muted small">
              {t(
                "作った順に、下書きとして後ろに追加します（今のゲームは消しません）。結果入力の枠に選ぶ人は、取り込んだ後に選んでください。",
                "Added at the end as drafts, in the order they were made (current games aren’t deleted). Choose people for result-entry slots after importing.",
              )}
            </p>
          </Section>
        )}
        {data.prizes && (
          <Section
            title={t(`景品（${data.prizes.length} 件）`, `Prizes (${data.prizes.length})`)}
            checked={include.prizes}
            onCheck={(v) => setInclude({ ...include, prizes: v })}
            disabled={locked}
            preview={<PrizePreview items={data.prizes} />}
          >
            <ModeChoice
              name="prize-mode"
              noun={t("景品", "prizes")}
              count={current.prizes.length}
              mode={prizeMode}
              onChange={setPrizeMode}
              addNote={t(
                "同じ順位に、今の景品と取り込んだ景品の両方が割り当たることがあります。",
                "A position may end up with both a current and an imported prize.",
              )}
            />
          </Section>
        )}
        {data.schedule && (
          <Section
            title={t(`スケジュール（${data.schedule.items.length} 件）`, `Schedule (${data.schedule.items.length})`)}
            checked={include.schedule}
            onCheck={(v) => setInclude({ ...include, schedule: v })}
            disabled={locked}
            preview={<SchedulePreview items={data.schedule.items} />}
          >
            <ModeChoice
              name="schedule-mode"
              noun={t("項目", "items")}
              count={current.scheduleItems.length}
              mode={scheduleMode}
              onChange={setScheduleMode}
              addNote={t(
                "取り込んだ項目は、今の項目の右の列に、ファイルの列の並びのまま置きます。",
                "Imported items go in columns to the right of the current ones, keeping the file’s column order.",
              )}
            />
            {data.schedule.date && (
              <label className="import-option">
                <input type="checkbox" checked={withDate} onChange={(e) => setWithDate(e.target.checked)} />
                {t(
                  `イベントの日付も取り込む（${data.schedule.date}。今は${current.scheduleDate ? ` ${current.scheduleDate}` : "決めていない"}）`,
                  `Also import the event date (${data.schedule.date}; currently ${current.scheduleDate || "not set"})`,
                )}
              </label>
            )}
          </Section>
        )}
        {data.settings && (
          <Section
            title={t("設定", "Settings")}
            checked={include.settings}
            onCheck={(v) => setInclude({ ...include, settings: v })}
            disabled={locked}
            preview={<SettingsPreview settings={data.settings} />}
          >
            <p className="muted small">
              {t(
                "今の設定を、取り込んだ内容に置き換えます（イベントの日付はそのまま）。写真の公開方法や参加者への公開も変わるので、選んだときだけ取り込みます。",
                "Replaces the current settings with the imported ones (the event date stays). This also changes how photos go public and what participants see, so it’s imported only when chosen.",
              )}
            </p>
          </Section>
        )}
        {progress && <p className="small">{progress}</p>}
        {error && <p className="error">{error}</p>}
        <div className="buttons">
          {finished ? (
            <button type="button" className="primary" onClick={props.onDone}>
              {t("閉じる", "Close")}
            </button>
          ) : (
            <>
              <button type="button" onClick={props.onClose} disabled={running}>
                {t("キャンセル", "Cancel")}
              </button>
              <button type="button" className="primary" onClick={run} disabled={running || nothing}>
                {running ? t("取り込み中…", "Importing…") : t("取り込む", "Import")}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** 種類ごとの欄。チェックで取り込むかを選び、中身の一覧と取り込み方を出す */
function Section(props: {
  title: string;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  disabled: boolean;
  preview: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="data-import-section" disabled={props.disabled}>
      <legend>
        <label className="import-option">
          <input type="checkbox" checked={props.checked} onChange={(e) => props.onCheck(e.target.checked)} />
          {props.title}
        </label>
      </legend>
      {props.checked && (
        <>
          <div className="table-wrap import-list">{props.preview}</div>
          {props.children}
        </>
      )}
    </fieldset>
  );
}

/** 追加か置き換えか（今あるものが無ければ選ばない） */
function ModeChoice(props: {
  name: string;
  noun: string;
  count: number;
  mode: Mode;
  onChange: (mode: Mode) => void;
  addNote: string;
}) {
  const t = useT();
  if (props.count === 0) return null;
  return (
    <div className="import-mode">
      <span className="small">
        {t(`今ある${props.noun}（${props.count} 件）は`, `The current ${props.noun} (${props.count}):`)}
      </span>
      <label>
        <input type="radio" name={props.name} checked={props.mode === "add"} onChange={() => props.onChange("add")} />
        {t("残して、後ろに追加する", "Keep them and add after")}
      </label>
      <label>
        <input
          type="radio"
          name={props.name}
          checked={props.mode === "replace"}
          onChange={() => props.onChange("replace")}
        />
        {t(`消して、取り込んだ${props.noun}に置き換える`, `Delete them and replace with the imported ${props.noun}`)}
      </label>
      {props.mode === "add" && <p className="muted small">{props.addNote}</p>}
    </div>
  );
}
