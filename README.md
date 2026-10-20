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

### 注意

- 管理者パスワードは Lambda の環境変数（と CloudFormation テンプレート）に平文で入る。
- 予算アラートは `Project=partally` タグで絞り込む。タグでの絞り込みには、請求コンソールで `Project` をコスト配分タグとして有効化しておく必要がある。
- DynamoDB テーブルは誤削除防止のため、スタックを削除しても残る（`RETAIN`）。
