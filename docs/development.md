# 開発ガイド

partally を開発するための資料です。作業の進め方のルールは [CLAUDE.md](../CLAUDE.md)、機能のルールは [機能仕様書](spec.md)、仕組みは [設計書](design.md)、本番へのデプロイは [初期設定・デプロイ手順](setup.md) を見てください。

## リポジトリ構成

npm workspaces のモノレポです。

| ディレクトリ | 内容 |
|---|---|
| `packages/shared` | API と画面で共有する型・入力検証（zod）・二つ名の単語リスト・景品の順位の計算 |
| `api` | API（Hono / AWS Lambda）、写真の取り込み、本番データの初期化と管理者ログインの制限の解除 |
| `web` | 画面（Vite + React の静的 SPA）。参加者の画面と管理画面 |
| `infra` | AWS CDK（DynamoDB / Lambda / API Gateway / S3 / CloudFront）。デプロイのときに動くカスタムリソースの Lambda（CloudFront 署名用の鍵ペア・CloudFront から API へ付ける秘密の値）は `infra/lambda` |
| `e2e` | 画面を通した E2E テスト（Playwright） |
| `docs` | 設計書・手順書・ガイド（一覧は [docs/README.md](README.md)） |
| `.github` | CI・リリース・初期化・管理者ログインの制限の解除（Unlock admin login）のワークフロー、AWS へのログインをまとめたアクション（`actions/aws-oidc`）、Issue・PR のテンプレート、Dependabot |

API（`api/src`）の主なファイル:

| ファイル | 内容 |
|---|---|
| `app.ts` | `createApp()`。CloudFront を通ったかの確かめ（`X-Origin-Verify`）、CSP の報告の受け口、共通のミドルウェアと管理者の認証（`/admin/*`）を付けてから、`routes/` の処理を登録する |
| `routes/context.ts` | 処理の間で共有する依存と部品（Cookie、署名付き URL、点数の読み込み、`requireUser`・`requireAdmin` など） |
| `routes/<領域>.ts` | API の処理（`auth`・`admin`・`ranking`・`photos`・`prizes`・`schedule`・`games`・`csp-report`） |
| `scoring.ts` | ゲームの点数・ポイント・ランキングの計算（保存せず、毎回データから数える） |
| `dto.ts` / `http.ts` | 応答の形への変換 / エラーの応答と入力の検証 |
| `repository.ts` ほか | 保存先（DynamoDB とメモリ）、写真の保存と取り込み、セッション |

画面（`web/src`）は、`pages/` に画面ごと（管理画面は `pages/admin/`）、`components/` に参加者の画面と管理画面で共通の部品を置きます。大きな画面のダイアログは、画面の名前のフォルダに分けます（データの移行は `pages/admin/data/` に種類ごとの書き出し・取り込みと取り込みの画面、管理画面のゲームは `pages/admin/games/` に、作成・編集・答えの一覧・プレビュー・人を選ぶダイアログと、形式の表）。管理画面の画面どうしで共通の部品は `pages/admin/` に置きます（景品・ゲームの画像の入力 `ImageField`、画像のアップロード `prizeImage.ts`）。

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
npm run e2e       # 画面を通した E2E テスト（Playwright。API と画面を起動して実行する）
```

PR を出す前に、CI と同じ確認（`npx biome ci .`・`npm run typecheck`・`npm test`・`npm run build`）を手元で通します。画面に関わる変更では `npm run e2e` も通します（CI でも実行します）。

- テストは `packages/shared`・`api` では `src/**/*.test.ts`、`infra` では `test/*.test.ts` にあります。API のテストはメモリ上のリポジトリ・ストレージで動かし、DynamoDB・S3・CloudFront を呼ぶ部分は `aws-sdk-client-mock` で確かめます。
- API のテストは領域ごとに `api/src/app.<領域>.test.ts`（`app.auth`・`app.accounts`・`app.admin`・`app.admin-login`・`app.admin-session`・`app.photos`・`app.upload-limit`・`app.favorites`・`app.game`・`app.game-<形式>`・`app.round`・`app.prizes`・`app.schedule`・`app.event`・`app.ingest`・`app.origin-verify`・`app.csp-report`）に、ランキングの計算は `scoring.test.ts` に分けています。部品ごとのテスト（`session`・`url-signer`・`photo-storage`・`dynamo-repository`・`cached-value`・`reset`）もあります。共通の準備は `api/src/test-support.ts` の `useApiTest()` を使います（テストごとにメモリ上のリポジトリとアプリを作り直し、`register()` で参加者の登録、`adminClient()` で管理者のログインまで済ませたクライアントを返します）。
- 画面（`web`）の単体テストは少ししかありません。画面の計算のうち、テストしたいもの（景品の順位の数え方など）は `packages/shared` に置いてテストします。
- 画面を通した流れは、`e2e/tests` の E2E テスト（Playwright）で確かめます。一覧と分担は [E2E テスト一覧](e2e-tests.md) にあります。
  - `npm run e2e` は、メモリ上の API（`api/src/dev.ts`）と画面（Vite）、本番と同じビルドの画面（`vite preview`。CSP を効かせるテストで使います）を起動してから実行します。手元で起動済みなら、それを使います。本番 AWS には流しません。
  - API は 1 つでデータはテストの間で共有されるので、1 つずつ順に実行します。各テストは自分で作ったデータだけを見て、開催中のゲームやイベントの終了を残さないようにします。
  - 準備のデータ（QR の発行・参加者の登録・ゲームの作成）は `e2e/tests/helpers.ts` の `adminApi()`・`participant()` で API から作り、確かめたい流れだけを画面から操作します。確認ダイアログは `acceptConfirm()` で「OK」を押します。
  - 手元で初めて実行するときは、`npx playwright install chromium`（`e2e` で）でブラウザを入れます。

## コードの約束事

- lint と整形は [Biome](https://biomejs.dev/) で行います。設定は `biome.json`。エディタに Biome の拡張機能（VS Code なら `biomejs.biome`）を入れると、保存時に整形できます。
- `style/noNonNullAssertion` は無効にしています。`noUncheckedIndexedAccess` を有効にしているため、添字アクセスの後の `!` を意図して使います。テストでは `any` を許可しています。
- コメントは日本語で書きます。画面の文言は日本語と英語を、呼ぶ所に並べて書きます（`web/src/i18n.tsx` の `t("日本語", "English")`。画面の中では `useT()`、React の外では `tr()`）。新しい画面も、日本語と英語の両方で書きます。英語の点数・人数は `pts(n)`・`people(n)` で書きます。
- 英語は短く平易に書き、ボタンは動詞で始めます（例: Register, Log in）。数で変わる語は単数・複数を分けます（1 point / 2 points）。幹事や参加者が入れた内容と二つ名は訳しません。
- 設定（`Settings`）に項目を足すときは、`updateSettingsRequestSchema` で省略可にし、`DEFAULT_SETTINGS` に既定値を入れます。保存済みの設定に無い項目は既定値で補われます（古い画面から保存されても 400 にしないため）。
- ゲームの形式ごとの決まりは表にまとめています。答えに使う項目と順位の単位は `packages/shared/src/game-rules.ts` の `GAME_FORMAT_RULES`、点数の数え方は `api/src/scoring.ts` の `GAME_SCORING` に書きます。形式を足すときは、`GAME_FORMATS` と、この 2 つの表と、形式ごとの名前・表示の表（`GAME_FORMAT_LABEL` と英語の `GAME_FORMAT_LABEL_EN`、お知らせの `game-banner.ts`（日本語と英語）、管理画面の `web/src/pages/admin/games/formats.ts` のアイコン・説明（`FORMAT_TEXT` と英語の `FORMAT_TEXT_EN`）・並び）と、画面（`GameView`・管理画面のゲーム）を直します。足し忘れた表は型チェックで分かります。
- 管理画面の一覧（GSI で読むもの）は、保存・削除の直後に取り直すと古い内容が返ることがあります（反映が少し遅れるため）。保存・削除の後は、応答で受け取ったものを `web/src/hooks/useFreshList.ts` で一覧に重ね、取り直した一覧だけに頼らないでください。
- 確認は `window.confirm()` ではなく、`web/src/components/ConfirmDialog.tsx` の `confirmDialog()`（画面内の確認ダイアログ）を使います（`if (!(await confirmDialog("…よろしいですか？"))) return;`）。ブラウザ標準のダイアログは、自動操作で承認できず、見た目もほかのモーダルと揃わないためです。
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
| `unlock-admin-login.yml` | 手動実行 | 管理者のログインの制限の解除（[手順](setup.md#管理者のログインの制限の解除)） |

依存パッケージと Actions の更新は、Dependabot が毎週 `develop` 宛てに PR を作ります。

ワークフローで使うアクションは、次のように指定します（`infra/test/workflows.test.ts` で確かめています）。

- GitHub 以外が作るアクション（`actions/*` 以外）は、コミットの SHA で固定し、後ろのコメントに元の版を書きます（例: `uses: softprops/action-gh-release@<40 桁の SHA> # v3.0.4`）。タグは付け替えられるので、作者のアカウントが乗っ取られると中身を差し替えられるためです。Dependabot は SHA とコメントをまとめて更新します。
- GitHub 公式のアクション（`actions/*`）は、版の番号（`@v7` など）で指定します。
- このリポジトリの中のアクション（`./.github/actions/*`）はそのまま使います。
