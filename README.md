# partally

忘年会などの余興イベント向けの、参加者管理・写真共有・ポイント集計システム（社内用）。

設計は [docs/design.md](docs/design.md) を参照。

## 現在できること

- QR トークンの発行と印刷用ページ（管理画面）
- QR 読み込み → 名前入力 → 二つ名の自動付与 → Cookie でログイン維持
- 管理画面でのユーザ一覧・名前／二つ名の変更・QR との紐づけ解除

写真共有・ポイント集計は今後実装する。

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

## ローカル開発

AWS なしで動かせる。API は DynamoDB の代わりにメモリ上のデータを使う（再起動で消える）。

```sh
npm install
npm run dev:api   # http://localhost:8787 。起動時にお試し用の QR URL を 5 件表示する
npm run dev:web   # http://localhost:5173 （/api は API へプロキシ）
```

- 管理画面: http://localhost:5173/admin （パスワードは `admin`。`ADMIN_PASSWORD` で変更可）
- 参加者: `dev:api` のログに出る `http://localhost:5173/q/...` を開く

## テスト・型チェック

```sh
npm test
npm run typecheck
```

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
