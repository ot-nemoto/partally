# CLAUDE.md

このリポジトリで作業するときのルール。資料の一覧は [docs/README.md](docs/README.md)。開発の手順（ローカル開発・テスト・コードの約束事）は [docs/development.md](docs/development.md)、仕組みは [docs/design.md](docs/design.md)、初期設定とデプロイは [docs/setup.md](docs/setup.md) を参照。

## 作業の進め方

すべての作業は Issue から始める。

1. **Issue を作る**。本文には次の 3 つを必ず書く（GitHub の画面では「作業」テンプレート `.github/ISSUE_TEMPLATE/task.yml` で必須にしている。API などで作るときも同じ見出しで書く）。
   - **概要**: 何のために、何をするか
   - **作業内容**: 変更する内容と方針
   - **確認内容**: 何を、どうやって確かめるか（テスト・lint・型チェック・ブラウザでの動作確認など）
2. **ブランチで作業する**。`develop`・`master` へ直接 push しない。
3. **`develop` 宛ての PR を作る**。`.github/pull_request_template.md` に沿って、`Closes #<Issue 番号>` と実際に行った確認とその結果を書く。
4. **CI とレビューの指摘に対応する**。CI（`.github/workflows/ci.yml`）が通るまで直す。
5. **マージはユーザが行う**。develop へマージすると、CI（`ci.yml`）がテストの後に本番へ自動でデプロイする（GitHub の `production` Environment でデプロイできるブランチを `develop` に限っている）。デプロイし直すときは、ユーザから指示があったときだけ CI ワークフローを `develop` で手動実行する。
6. **リリースは自動 PR で行う**。毎朝 develop → master の PR が自動で作られ（`auto-pr-to-master.yml`）、付いた `bump:patch` / `bump:minor` ラベルでバージョンが上がる（`bump-version.yml`）。ユーザが「Create a merge commit」でマージすると、master でタグと GitHub Release が作られる（`release.yml`）。Issue に `enhancement` ラベルがあると minor、なければ patch になる。

作業の途中で範囲が変わったら、Issue の作業内容・確認内容も更新する。

## 守ること

- 個人や環境の情報（AWS アカウント ID、ロール ARN、メールアドレス、パスワード、実際のドメインなど）をリポジトリに書かない。必要な値は GitHub の Environment secrets / variables か SSM に置く。
- 公開リポジトリなので、Actions のログに出る値にも気をつける（秘密の値は Secret にする）。
- テストを無効化・スキップして CI を通さない。

## 確認すること

- PR を出す前に、CI と同じ確認を手元で通す: `npx biome ci .`・`npm run typecheck`・`npm test`・`npm run build`。整形の自動修正は `npm run format`。
- 画面に関わる変更は、ローカルで API と画面を起動してブラウザで動きを確かめる（起動方法は [docs/development.md](docs/development.md#ローカル開発)）。

## 資料を更新すること

変更に合わせて、関係する資料も同じ PR で直す。

| 変更したもの | 直す資料 |
|---|---|
| 参加者の画面・使い方 | `README.md` |
| 管理画面・幹事の操作 | `docs/organizer-guide.md` |
| API・データ・設定の項目・画面の一覧 | `docs/design.md` |
| デプロイ・環境変数・AWS のリソース | `docs/setup.md` |
| 開発の手順・コマンド・ワークフロー | `docs/development.md` |

## リポジトリの基本

- 開発のメインブランチ（デフォルトブランチ）は `develop`。`master` はリリース済みの版を置く。
- npm workspaces のモノレポ（`packages/shared`・`api`・`web`・`infra`）。Node.js 22 と npm 11 以上を使う。
