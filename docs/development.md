# 開発ガイド

partally を開発するための資料です。作業の進め方のルールは [CLAUDE.md](../CLAUDE.md)、仕組みは [設計書](design.md)、本番へのデプロイは [初期設定・デプロイ手順](setup.md) を見てください。

## リポジトリ構成

npm workspaces のモノレポです。

| ディレクトリ | 内容 |
|---|---|
| `packages/shared` | API と画面で共有する型・入力検証（zod）・二つ名の単語リスト・景品の順位の計算 |
| `api` | API（Hono / AWS Lambda）、写真の取り込み、本番データの初期化 |
| `web` | 画面（Vite + React の静的 SPA）。参加者の画面と管理画面 |
| `infra` | AWS CDK（DynamoDB / Lambda / API Gateway / S3 / CloudFront） |
| `docs` | 設計書・手順書・ガイド（一覧は [docs/README.md](README.md)） |
| `.github` | CI・リリース・初期化のワークフロー、Issue・PR のテンプレート、Dependabot |

## 必要なもの

- Node.js 22
- npm 11 以上（npm 10 では依存解決時にエラーになることがあるため。`npx npm@11 install` でも可）
- デプロイするときは AWS CLI と認証情報（[初期設定・デプロイ手順](setup.md)）

## ローカル開発

AWS なしで動かせます。API は DynamoDB・S3 の代わりにメモリ上のデータを使います（再起動で消えます）。写真・景品の画像のアップロードと配信もローカルで再現します（署名の確認は省きます）。

```sh
npm install
npm run dev:api   # http://localhost:8787 。起動時にお試し用の QR URL を 5 件表示する
npm run dev:web   # http://localhost:5173 （/api・/photos・/prizes は API へプロキシ）
```

- 管理画面: http://localhost:5173/admin （パスワードは `admin`。`ADMIN_PASSWORD` で変えられる）
- 参加者: `dev:api` のログに出る `http://localhost:5173/q/...` を開く
- スマホから試すときは、`WEB_ORIGIN=http://<PC の IP>:5173 npm run dev:api` と `npm run dev -w web -- --host` で起動し（`--host` で画面をほかの端末から開けるようにする）、ログに出る URL を開く

画面に関わる変更は、ローカルで API と画面を起動して、ブラウザで動きを確かめます。

### ローカルの環境変数（`npm run dev:api`、すべて任意）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `8787` | API のポート。変えるときは、画面のプロキシ先（`web/vite.config.ts` の `api`）も合わせて変える |
| `WEB_ORIGIN` | `http://localhost:5173` | 起動ログに出すお試し用 QR URL・管理画面 URL のオリジン |
| `ADMIN_PASSWORD` | `admin` | ローカルの管理者パスワード |

## テスト・型チェック・lint

```sh
npm test          # 全パッケージのテスト（Vitest）
npm run typecheck # 全パッケージの型チェック
npm run lint      # Biome による lint と整形のチェック
npm run format    # 整形と import の並べ替え、安全な自動修正を適用する
npm run build     # 画面のビルド
```

PR を出す前に、CI と同じ確認（`npx biome ci .`・`npm run typecheck`・`npm test`・`npm run build`）を手元で通します。

- テストは `packages/shared`・`api` では `src/**/*.test.ts`、`infra` では `test/*.test.ts` にあります。API のテストはメモリ上のリポジトリ・ストレージで動かし、DynamoDB・S3・CloudFront を呼ぶ部分は `aws-sdk-client-mock` で確かめます。
- 画面（`web`）には自動テストがありません。画面の計算のうち、テストしたいもの（景品の順位の数え方など）は `packages/shared` に置いてテストします。

## コードの約束事

- lint と整形は [Biome](https://biomejs.dev/) で行います。設定は `biome.json`。エディタに Biome の拡張機能（VS Code なら `biomejs.biome`）を入れると、保存時に整形できます。
- `style/noNonNullAssertion` は無効にしています。`noUncheckedIndexedAccess` を有効にしているため、添字アクセスの後の `!` を意図して使います。テストでは `any` を許可しています。
- コメントと画面の文言は日本語で書きます。
- 設定（`Settings`）に項目を足すときは、`updateSettingsRequestSchema` で省略可にし、`DEFAULT_SETTINGS` に既定値を入れます。保存済みの設定に無い項目は既定値で補われます（古い画面から保存されても 400 にしないため）。
- 個人や環境の情報（AWS アカウント ID、ロール ARN、メールアドレス、パスワード、実際のドメインなど）はリポジトリに書きません。

## ブランチ・PR・リリース

- 開発のメインブランチは `develop`、リリース済みの版は `master` に置きます。`develop`・`master` へ直接 push しません。
- 作業は Issue から始め、ブランチで作業して `develop` 宛ての PR を作ります（詳しくは [CLAUDE.md](../CLAUDE.md)）。

| ワークフロー | いつ動くか | 何をするか |
|---|---|---|
| `ci.yml` | `develop` 宛ての PR、`develop` への push、手動実行 | lint・型チェック・テスト・ビルド。`develop` への push と、`develop` を選んだ手動実行では、続けて本番へデプロイする |
| `auto-pr-to-master.yml` | 毎朝 | `develop` → `master` の PR を作り、Issue のラベルから `bump:patch` / `bump:minor` を付ける |
| `bump-version.yml` | 上の PR のラベル | バージョンを上げる（Issue に `enhancement` があれば minor、なければ patch） |
| `release.yml` | `master` へのマージ | タグと GitHub Release を作る |
| `reset.yml` | 手動実行 | 本番データの初期化（[手順](setup.md#本番データの初期化)） |

依存パッケージと Actions の更新は、Dependabot が毎週 `develop` 宛てに PR を作ります。
