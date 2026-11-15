import type { PrizeDto, ScheduleItemDto } from "@partally/shared";
import type { DataArchive } from "@partally/shared/data-archive";
import { type ReactNode, useState } from "react";
import { ApiError, api, errorMessage } from "../../../api";
import { Modal } from "../../../components/Modal";
import { GamePreview, importGame } from "./games";
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
 * 景品 → ゲーム → スケジュール → 設定の順に 1 件ずつ取り込む。
 * 置き換えは、その種類をすべて取り込めてから今のものを消す（途中で失敗しても、今のものが無くならないように）
 */
export function DataImportDialog(props: {
  data: DataArchive;
  current: CurrentData;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data, current } = props;
  const [include, setInclude] = useState({
    prizes: !!data.prizes,
    games: !!data.games,
    schedule: !!data.schedule,
    settings: !!data.settings,
  });
  const [prizeMode, setPrizeMode] = useState<Mode>("add");
  const [scheduleMode, setScheduleMode] = useState<Mode>("add");
  const [withDate, setWithDate] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const locked = running || finished;
  const nothing = !Object.values(include).some(Boolean);

  async function run() {
    const removing = [
      include.prizes && prizeMode === "replace" && current.prizes.length > 0 && `景品 ${current.prizes.length} 件`,
      include.schedule &&
        scheduleMode === "replace" &&
        current.scheduleItems.length > 0 &&
        `スケジュールの項目 ${current.scheduleItems.length} 件`,
    ].filter(Boolean);
    const notes = [
      removing.length > 0 && `今の${removing.join("・")}を削除し、取り込んだものに置き換えます。`,
      include.settings && "設定は、取り込んだ内容に置き換わります。",
    ].filter(Boolean);
    if (notes.length > 0 && !confirm(`${notes.join("\n")}\nよろしいですか？`)) return;

    setRunning(true);
    setError(undefined);
    /** 今していること（止まったときの表示に使う） */
    let doing = "";
    const done: string[] = [];
    /** items を 1 件ずつ取り込む。置き換えのときは、取り込めてから今のものを消す（ほかの画面で消されていたら飛ばす） */
    async function step<T>(
      label: string,
      items: T[],
      nameOf: (item: T) => string,
      importOne: (item: T) => Promise<void>,
      removers: (() => Promise<unknown>)[] = [],
    ) {
      for (const [i, item] of items.entries()) {
        doing = `${label}の ${i + 1} 件目（${nameOf(item)}）`;
        setProgress(`${label}を取り込み中… ${i + 1} / ${items.length}`);
        await importOne(item);
      }
      for (const [i, remove] of removers.entries()) {
        doing = `今の${label}の削除`;
        setProgress(`今の${label}を削除中… ${i + 1} / ${removers.length}`);
        try {
          await remove();
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
      }
      done.push(`${label} ${items.length} 件`);
    }
    try {
      if (include.prizes && data.prizes) {
        const removers =
          prizeMode === "replace" ? current.prizes.map((p) => () => api("DELETE", `/admin/prizes/${p.prizeId}`)) : [];
        await step("景品", data.prizes, (p) => p.name, importPrize, removers);
      }
      if (include.games && data.games) {
        await step("ゲーム", data.games, (g) => g.name, importGame);
      }
      if (include.schedule && data.schedule) {
        const removers =
          scheduleMode === "replace"
            ? current.scheduleItems.map((item) => () => api("DELETE", `/admin/schedule/${item.itemId}`))
            : [];
        await step("スケジュール", data.schedule.items, (item) => item.title, importScheduleItem, removers);
      }
      const date = include.schedule && withDate ? data.schedule?.date : undefined;
      if ((include.settings && data.settings) || date) {
        doing = "設定の保存";
        setProgress("設定を保存中…");
        await saveSettings({ settings: include.settings ? data.settings : undefined, scheduleDate: date });
      }
      props.onDone();
    } catch (e) {
      const before = done.length > 0 ? `（${done.join("・")}は取り込み済み）` : "";
      setError(`${doing}で止まりました${before}。置き換えの、まだ消していない分は残っています。${errorMessage(e)}`);
      setFinished(true);
    } finally {
      setRunning(false);
      setProgress(undefined);
    }
  }

  return (
    <Modal className="dialog import-dialog" label="インポート" onClose={props.onClose} closable={!running}>
      <div className="card">
        <h2>インポート</h2>
        <p className="small">取り込むものを選んでください。上から順に取り込みます。</p>
        {data.prizes && (
          <Section
            title={`景品（${data.prizes.length} 件）`}
            checked={include.prizes}
            onCheck={(v) => setInclude({ ...include, prizes: v })}
            disabled={locked}
            preview={<PrizePreview items={data.prizes} />}
          >
            <ModeChoice
              name="prize-mode"
              noun="景品"
              count={current.prizes.length}
              mode={prizeMode}
              onChange={setPrizeMode}
              addNote="同じ順位に、今の景品と取り込んだ景品の両方が割り当たることがあります。"
            />
          </Section>
        )}
        {data.games && (
          <Section
            title={`ゲーム（${data.games.length} 件）`}
            checked={include.games}
            onCheck={(v) => setInclude({ ...include, games: v })}
            disabled={locked}
            preview={<GamePreview items={data.games} />}
          >
            <p className="muted small">
              作った順に、<strong>下書き</strong>として後ろに追加します（今のゲームは消しません）。
              結果入力の枠に選ぶ人は、取り込んだ後に選んでください。
            </p>
          </Section>
        )}
        {data.schedule && (
          <Section
            title={`スケジュール（${data.schedule.items.length} 件）`}
            checked={include.schedule}
            onCheck={(v) => setInclude({ ...include, schedule: v })}
            disabled={locked}
            preview={<SchedulePreview items={data.schedule.items} />}
          >
            <ModeChoice
              name="schedule-mode"
              noun="項目"
              count={current.scheduleItems.length}
              mode={scheduleMode}
              onChange={setScheduleMode}
              addNote="時間が重なる項目は、横に並べて表示します。"
            />
            {data.schedule.date && (
              <label className="import-option">
                <input type="checkbox" checked={withDate} onChange={(e) => setWithDate(e.target.checked)} />
                イベントの日付も取り込む（{data.schedule.date}。今は
                {current.scheduleDate ? ` ${current.scheduleDate}` : "決めていない"}）
              </label>
            )}
          </Section>
        )}
        {data.settings && (
          <Section
            title="設定"
            checked={include.settings}
            onCheck={(v) => setInclude({ ...include, settings: v })}
            disabled={locked}
            preview={<SettingsPreview settings={data.settings} />}
          >
            <p className="muted small">今の設定を、取り込んだ内容に置き換えます（イベントの日付はそのまま）。</p>
          </Section>
        )}
        {progress && <p className="small">{progress}</p>}
        {error && <p className="error">{error}</p>}
        <div className="buttons">
          {finished ? (
            <button type="button" className="primary" onClick={props.onDone}>
              閉じる
            </button>
          ) : (
            <>
              <button type="button" onClick={props.onClose} disabled={running}>
                キャンセル
              </button>
              <button type="button" className="primary" onClick={run} disabled={running || nothing}>
                {running ? "取り込み中…" : "取り込む"}
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
  if (props.count === 0) return null;
  return (
    <div className="import-mode">
      <span className="small">
        今ある{props.noun}（{props.count} 件）は
      </span>
      <label>
        <input type="radio" name={props.name} checked={props.mode === "add"} onChange={() => props.onChange("add")} />
        残して、後ろに追加する
      </label>
      <label>
        <input
          type="radio"
          name={props.name}
          checked={props.mode === "replace"}
          onChange={() => props.onChange("replace")}
        />
        消して、取り込んだ{props.noun}に置き換える
      </label>
      {props.mode === "add" && <p className="muted small">{props.addNote}</p>}
    </div>
  );
}
