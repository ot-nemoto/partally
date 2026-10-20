import type { MeResponse, UserDto } from "@partally/shared";
import { useEffect, useState } from "react";
import { ApiError, api, errorMessage } from "../api";

type State =
  | { kind: "loading" }
  | { kind: "guest" }
  | { kind: "user"; user: UserDto }
  | { kind: "error"; message: string };

export function Home() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    api<MeResponse>("GET", "/me")
      .then((res) => setState({ kind: "user", user: res.user }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setState({ kind: "guest" });
        else setState({ kind: "error", message: errorMessage(e) });
      });
  }, []);

  return (
    <main className="page">
      {state.kind === "loading" && <p className="muted">読み込み中…</p>}
      {state.kind === "error" && <p className="error">{state.message}</p>}

      {state.kind === "guest" && (
        <section className="card">
          <h1>partally</h1>
          <p>配布された QR コードをスマホのカメラで読み込んでください。</p>
        </section>
      )}

      {state.kind === "user" && (
        <>
          <section className="card profile">
            <p className="epithet">〈{state.user.epithet}〉</p>
            <p className="name">{state.user.name}</p>
          </section>
          <section className="card">
            <dl className="stats">
              <div>
                <dt>アップロード</dt>
                <dd>{state.user.uploadCount}</dd>
              </div>
              <div>
                <dt>公開中</dt>
                <dd>{state.user.approvedCount}</dd>
              </div>
            </dl>
            <p className="muted small">写真の撮影・共有は準備中です。</p>
          </section>
        </>
      )}
    </main>
  );
}
