# partally

忘年会などの余興イベント向けの、参加者管理・写真共有・ポイント集計システム（社内用）。

設計は [docs/design.md](docs/design.md) を参照。

## 現在できること

- QR トークンの発行と印刷用ページ（管理画面）
- QR 読み込み → 名前入力 → 二つ名の自動付与 → Cookie でログイン維持
- 管理画面でのユーザ一覧・名前／二つ名の変更・QR との紐づけ解除
- 写真の撮影・アップロード（ブラウザ側で縮小・HEIC 変換、通信が切れても自動で再送）
- 管理者による写真の検閲（承認後に公開／即時公開を設定で切り替え）、公開済み写真の削除
- 公開済み写真のギャラリー、自分の写真と状態の確認、ユーザごとのアップロード数・公開数
- ポイント：写真が公開されると 1 枚ごと、お気に入りに選ばれると 1 回ごとにポイントが入る（点数と、参加者のホーム画面に表示するかは管理画面で設定）
- お気に入り：「みんなの写真」で他の人の写真を上限（既定 10 枚）まで選べる。受付のオン／オフと上限は管理画面で設定
- クイズ：管理者が選択肢付きの問題を作り（選択肢ごとに点数を設定）、好きなタイミングで出題・締め切り。参加者はスマホで答え、締め切った時点の回答の点数がポイントに入る

## 構成

| ディレクトリ | 内容 |
|---|---|
| `packages/shared` | API と画面で共有する型・入力検証・二つ名の単語リスト |
| `api` | API（Hono / AWS Lambda） |
| `web` | 画面（Vite + React の静的 SPA） |
| `infra` | AWS CDK（DynamoDB / Lambda / API Gateway / S3 / CloudFront） |

## 必要なもの

- Node.js 22
- npm 11 以上（npm 10 では依存解決時にエラーになることがあるため。`npx npm@11 install` でも可）
- デプロイ時: AWS CLI と認証情報

## 開発の進め方

作業は Issue から始め、概要・作業内容・確認内容を必ず書く（「作業」テンプレートで必須）。ブランチで作業して `master` 宛ての PR を作り、PR テンプレートに沿って `Closes #<Issue 番号>` と実際に行った確認を書く。詳しくは [CLAUDE.md](CLAUDE.md) を参照。

## ローカル開発

AWS なしで動かせる。API は DynamoDB・S3 の代わりにメモリ上のデータを使う（再起動で消える）。写真のアップロード・配信もローカルで再現する（署名の確認は省略）。

```sh
npm install
npm run dev:api   # http://localhost:8787 。起動時にお試し用の QR URL を 5 件表示する
npm run dev:web   # http://localhost:5173 （/api は API へプロキシ）
```

- 管理画面: http://localhost:5173/admin （パスワードは `admin`。`ADMIN_PASSWORD` で変更可）
- 参加者: `dev:api` のログに出る `http://localhost:5173/q/...` を開く

## テスト・型チェック・lint

```sh
npm test
npm run typecheck
npm run lint     # Biome による lint と整形のチェック
npm run format   # 整形と import の並べ替え、安全な自動修正を適用する
```

- lint と整形は [Biome](https://biomejs.dev/) で行う。設定は `biome.json`。
- `style/noNonNullAssertion` は無効にしている（`noUncheckedIndexedAccess` を有効にしているため、添字アクセスの後の `!` を意図して使う）。テストでは `any` を許可している。
- master 宛ての PR と master への push では GitHub Actions の CI（`.github/workflows/ci.yml`）が lint・型チェック・テスト・ビルドを実行する。デプロイ（`deploy.yml`）は型チェックとテストだけを行う。
- エディタは Biome の拡張機能（VS Code なら `biomejs.biome`）を入れると、保存時に整形できる。

## デプロイ

初期設定とデプロイの手順は [docs/setup.md](docs/setup.md) を参照。

- **GitHub Actions から（推奨）**: AWS 側で署名鍵・CDK ブートストラップ・デプロイ用 IAM ロールを用意し、GitHub の `production` Environment に設定を登録して、Actions の Deploy ワークフローを手動実行する。
- **手元の PC から**: 同じ AWS 側の準備をした上で `npm run deploy`。

デプロイ後、管理画面で QR を発行して印刷する。QR はデプロイ先の URL を指すため、**本番の管理画面から印刷すること**。

## 環境変数

### デプロイ時（`npm run deploy` を実行するシェルで設定）

| 変数 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `PARTALLY_ADMIN_PASSWORD` | ○ | – | 管理画面のログインパスワード。Lambda の環境変数 `ADMIN_PASSWORD` として渡る。未設定だと synth/deploy がエラーで止まる |
| `PARTALLY_BUDGET_EMAIL` | – | – | 設定すると AWS Budgets の月額予算を作成し、このアドレスにアラートメールを送る。未設定なら予算は作らない |
| `PARTALLY_BUDGET_USD` | – | `5` | 月額予算の金額（USD）。実績がこの 80% を超えると通知する。`PARTALLY_BUDGET_EMAIL` 未設定時は無視される |
| `AWS_PROFILE` / `AWS_REGION` など | – | – | 通常の AWS CLI の認証・リージョン設定。CDK はここからデプロイ先アカウント・リージョンを決める（`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` として CDK CLI が自動で設定する）。リージョンが取れない場合は `ap-northeast-1` |

予算アラートは通知するだけで、リソースを止めたり課金を制限したりはしない。

セッション署名鍵を置く SSM パラメータ名は環境変数ではなく `infra/cdk.json` の `context.sessionSecretParam`（既定 `/partally/session-secret`）で指定する。

### Lambda 実行時（CDK が自動で設定するため、手動での設定は不要）

| 変数 | 説明 |
|---|---|
| `TABLE_NAME` | DynamoDB テーブル名 |
| `ADMIN_PASSWORD` | 管理者パスワード（`PARTALLY_ADMIN_PASSWORD` の値） |
| `SESSION_SECRET_PARAM` | セッション署名鍵の SSM パラメータ名。コールドスタート時に値を取得する |
| `NODE_OPTIONS` | `--enable-source-maps`（エラーのスタックトレースを TypeScript の行番号で出す） |

### ローカル開発時（`npm run dev:api`、すべて任意）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `8787` | API のポート |
| `WEB_ORIGIN` | `http://localhost:5173` | 起動ログに出すお試し用 QR URL・管理画面 URL のオリジン。スマホから試すときは `http://<PC の IP>:5173` にする |
| `ADMIN_PASSWORD` | `admin` | ローカルの管理者パスワード |

### 注意

- 管理者パスワードは Lambda の環境変数（と CloudFormation テンプレート）に平文で入る。
- 予算アラートは `Project=partally` タグで絞り込む。タグでの絞り込みには、請求コンソールで `Project` をコスト配分タグとして有効化しておく必要がある。
- DynamoDB テーブルは誤削除防止のため、スタックを削除しても残る（`RETAIN`）。
