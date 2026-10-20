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

1. セッション署名鍵を SSM Parameter Store に作成する（初回のみ）

   ```sh
   aws ssm put-parameter --region ap-northeast-1 \
     --name /partally/session-secret --type SecureString \
     --value "$(openssl rand -base64 48)"
   ```

2. CDK のブートストラップ（そのアカウント・リージョンで初回のみ）

   ```sh
   npm run cdk -w infra -- bootstrap
   ```

3. 画面をビルドしてデプロイする

   ```sh
   export PARTALLY_ADMIN_PASSWORD='管理者パスワード'
   export PARTALLY_BUDGET_EMAIL='alert@example.com'   # 任意: 月額予算アラートの通知先
   export PARTALLY_BUDGET_USD=5                        # 任意: 予算（既定 5 USD）
   npm run deploy
   ```

   出力の `Url` が参加者向け、`AdminUrl` が管理画面。

4. 管理画面で QR を発行し、「未使用分を印刷」から印刷する。QR はデプロイ先の URL を指すため、**デプロイ後のドメインで印刷すること**。

## GitHub Actions からのデプロイ

`.github/workflows/deploy.yml` を手動実行すると、テスト → 画面ビルド → CDK デプロイを行う。AWS へは OIDC でロールを引き受けるため、アクセスキーを GitHub に置かない。

### 初回設定

1. **AWS 側（CloudShell で実行）**: AWS コンソールの東京リージョンで CloudShell を開き、以下を実行する

   ```sh
   # セッション署名鍵
   aws ssm put-parameter --name /partally/session-secret --type SecureString \
     --value "$(openssl rand -base64 48)"

   # CDK のブートストラップ
   npx -y aws-cdk@2 bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/ap-northeast-1

   # GitHub Actions 用の IAM ロール
   curl -fsSLO https://raw.githubusercontent.com/ot-nemoto/partally/claude/friendly-shannon-yppq56/infra/github-oidc.yaml
   aws cloudformation deploy --stack-name partally-github-oidc \
     --template-file github-oidc.yaml --capabilities CAPABILITY_NAMED_IAM
   aws cloudformation describe-stacks --stack-name partally-github-oidc \
     --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text
   ```

   - アカウントに GitHub の OIDC プロバイダ（`token.actions.githubusercontent.com`）が既にある場合は、`deploy` に `--parameter-overrides CreateOidcProvider=false` を付ける。
   - 最後のコマンドで表示されたロール ARN を次の手順で使う。

2. **GitHub 側**: リポジトリの Settings → Environments → New environment で `production` を作り、以下を登録する

   | 種類 | 名前 | 値 |
   |---|---|---|
   | Secret | `PARTALLY_ADMIN_PASSWORD` | 管理者パスワード |
   | Variable | `AWS_ROLE_ARN` | 手順 1 で表示されたロール ARN |
   | Variable | `PARTALLY_BUDGET_EMAIL` | 任意: 予算アラートの通知先 |
   | Variable | `PARTALLY_BUDGET_USD` | 任意: 予算（USD） |

   Environment の「Required reviewers」に自分を入れると、デプロイ前に承認が必要になる。

### デプロイの実行

Actions タブ → Deploy → Run workflow。完了後、ジョブログの最後に出る `Partally.Url` / `Partally.AdminUrl` が URL。

### 仕組みと権限

- `infra/github-oidc.yaml` のロールは、このリポジトリの `production` Environment のジョブからしか引き受けられない。
- ロール自体の権限は CDK のブートストラップロール（`cdk-hnb659fds-*`）を引き受けることだけ。実際のリソース作成は、ブートストラップ時に作られた CloudFormation 実行ロールが行う。

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
