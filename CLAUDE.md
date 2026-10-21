# CLAUDE.md

このリポジトリで作業するときのルール。設計は [docs/design.md](docs/design.md)、初期設定とデプロイは [docs/setup.md](docs/setup.md) を参照。

## 作業の進め方

すべての作業は Issue から始める。

1. **Issue を作る**。本文には次の 3 つを必ず書く（テンプレート: `.github/ISSUE_TEMPLATE/task.md`）。
   - **概要**: 何のために、何をするか
   - **作業内容**: 変更する内容と方針
   - **確認内容**: 何を、どうやって確かめるか（テスト・lint・型チェック・ブラウザでの動作確認など）
2. **ブランチで作業する**。`master` へ直接 push しない。
3. **`master` 宛ての PR を作る**。本文に `Closes #<Issue 番号>` を書き、実際に行った確認とその結果を記載する。
4. **CI とレビューの指摘に対応する**。CI（`.github/workflows/ci.yml`）が通るまで直す。
5. **マージはユーザが行う**。デプロイはユーザから指示があったときだけ、Actions の Deploy ワークフロー（`deploy.yml`）を `master` で実行する。

作業の途中で範囲が変わったら、Issue の作業内容・確認内容も更新する。

## 守ること

- 個人や環境の情報（AWS アカウント ID、ロール ARN、メールアドレス、パスワード、実際のドメインなど）をリポジトリに書かない。必要な値は GitHub の Environment secrets / variables か SSM に置く。
- 公開リポジトリなので、Actions のログに出る値にも気をつける（秘密の値は Secret にする）。
- テストを無効化・スキップして CI を通さない。

## リポジトリの基本

- メインブランチは `master`。
- npm workspaces のモノレポ（`packages/shared`・`api`・`web`・`infra`）。npm 11 以上を使う（`npx npm@11 install`）。
- よく使うコマンド:

  ```sh
  npm run lint       # Biome による lint と整形のチェック（CI と同じ）
  npm run format     # 整形と安全な自動修正
  npm run typecheck
  npm test
  npm run build      # 画面のビルド
  npm run dev:api    # ローカル API（http://localhost:8787）
  npm run dev:web    # ローカル画面（http://localhost:5173）
  ```

- 画面に関わる変更は、ローカルで API と画面を起動してブラウザで動きを確かめる。
