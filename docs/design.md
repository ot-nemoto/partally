# partally 設計書

忘年会などの余興イベントで、参加者の管理・写真共有・ポイント集計を行う社内向け Web システム。

- 想定規模: 参加者 80 名程度 / 1 イベント
- 利用端末: 参加者はスマートフォン（ブラウザ）、管理者は PC またはスマートフォン
- 方針: サーバレス・低コスト・フロントエンドは静的コンテンツ

本書の対象は **ユーザ管理** と **写真共有** 。ポイント・余興イベントの集計は別途設計する（[今後の拡張](#9-今後の拡張) 参照）。

---

## 1. 要件まとめ

### 1.1 ユーザ管理

| # | 要件 |
|---|---|
| U-1 | 事前に個別の QR コードを配布する。QR には推測困難なランダムトークンを埋め込む |
| U-2 | 初回読み込み時に名前だけ入力し、トークンとユーザを紐づける |
| U-3 | 同名対策として、全ユーザに一意な「二つ名」を自動付与する |
| U-4 | 紐づけ後は QR を読み込むだけでログインできる |
| U-5 | ログイン状態は Cookie で持続する |
| U-6 | 名前・二つ名の変更は管理者のみ可能 |
| U-7 | QR とユーザの紐づけ解除は管理画面からのみ可能 |

### 1.2 写真共有

| # | 要件 |
|---|---|
| P-1 | 参加者は端末のカメラで撮影し、アップロードできる |
| P-2 | 公開された写真は参加者全員で共有（閲覧）する |
| P-3 | アップロード者を保持し、ユーザごとのアップロード数を管理する |
| P-4 | 写真の削除は管理者のみ可能 |
| P-5 | 公開前に管理者が検閲（承認）する。設定で「即時公開」に切り替え可能 |
| P-6 | iPhone の HEIC 形式は変換ライブラリでブラウザ側変換する |

### 1.3 今回は扱わないもの

- 写真の保存期間・ダウンロード可否・肖像権の同意取得（別途検討）
- QR の紛失・盗み見対策（紐づけ後も QR で再ログイン可能なままとする）
- 管理者の多要素認証（管理者パスワードは環境変数で 1 つ）

---

## 2. システム構成

AWS（ap-northeast-1）上に構築する。IaC は AWS CDK（TypeScript）。

```mermaid
flowchart LR
  subgraph Client[スマートフォン / PC]
    SPA[SPA<br/>Vite + React]
  end

  subgraph AWS
    CF[CloudFront]
    WebS3[(S3<br/>web バケット)]
    PhotoS3[(S3<br/>photos バケット)]
    APIGW[API Gateway<br/>HTTP API]
    ApiFn[Lambda<br/>api]
    IngestFn[Lambda<br/>photo-ingest]
    DDB[(DynamoDB)]
    SSM[SSM Parameter Store<br/>SecureString]
  end

  SPA -- "/*（静的）" --> CF
  SPA -- "/api/*" --> CF
  SPA -- "/photos/*（署名付き Cookie/URL）" --> CF
  CF --> WebS3
  CF --> APIGW --> ApiFn
  CF --> PhotoS3
  SPA -- "署名付き POST で直接アップロード" --> PhotoS3
  PhotoS3 -- "ObjectCreated イベント" --> IngestFn
  ApiFn --> DDB
  ApiFn --> PhotoS3
  ApiFn --> SSM
  IngestFn --> DDB
  IngestFn --> PhotoS3
```

### 2.1 CloudFront のビヘイビア

画面・API・写真を **同一ドメイン** で配信し、Cookie をファーストパーティで扱う。

| パスパターン | オリジン | 備考 |
|---|---|---|
| `/api/*` | API Gateway (HTTP API) | キャッシュ無効。Cookie・クエリ・必要ヘッダを転送 |
| `/photos/approved/*` | photos バケット (OAC) | **署名付き Cookie または URL** 必須（公開済み写真） |
| `/photos/pending/*` | photos バケット (OAC) | **署名付き URL** 必須（検閲待ち。管理者・本人のみ） |

- 写真の S3 キーは CloudFront のパスと同じ `photos/{pending|approved}/<photoId>/{full|thumb}.jpg` とし、パスの書き換えを不要にする。
- 署名はカスタムポリシーで、Resource のホスト部をワイルドカード（`https://*/photos/approved/*` など）にする。API がディストリビューションのドメインを知らなくてよく、鍵グループはこのディストリビューション専用なので他所では使えない。
| `/*`（デフォルト） | web バケット (OAC) | CloudFront Function で拡張子のないパスを `/index.html` に書き換え（SPA ルーティング） |

- S3 バケットはどちらも非公開（Block Public Access 有効）とし、CloudFront の OAC 経由でのみ読み取る。
- 写真は **必ず CloudFront 経由で配信** する（S3 から直接配信すると転送料が発生するため）。
- SPA フォールバックは「403/404 をカスタムエラーで index.html に返す」方式だと `/api` や `/photos` のエラーまで書き換わるため、CloudFront Function をデフォルトビヘイビアにのみ適用する。

### 2.2 Lambda

| 関数 | トリガ | 役割 |
|---|---|---|
| `api` | API Gateway | すべての API。Node.js 22 + [Hono](https://hono.dev/) で 1 関数内ルーティング |
| `photo-ingest` | S3 `ObjectCreated`（`photos/pending/*/full.jpg`） | アップロード完了の検証と写真レコード登録、アップロード数加算 |
| （カスタムリソース） | デプロイ時 | CloudFront 署名用の鍵ペアを生成し、秘密鍵を SSM に保存、公開鍵を CloudFront に登録 |

### 2.3 秘密情報

| 名前 | 保管場所 | 用途 |
|---|---|---|
| `ADMIN_PASSWORD` | Lambda 環境変数（デプロイ時に指定） | 管理者ログイン |
| `SESSION_SECRET` | SSM SecureString（`/partally/session-secret`） | セッション Cookie の HMAC 署名。作成手順と扱いは [setup.md](setup.md#セッション署名鍵とは) |
| CloudFront 署名用秘密鍵 | SSM SecureString（`/partally/cloudfront-private-key`） | 署名付き Cookie / URL の発行。**デプロイ時にカスタムリソースが自動生成**し、公開鍵だけを CloudFront の Key Group に登録する（テンプレートに秘密鍵は残らない） |

SSM Parameter Store の標準パラメータは無料。Lambda のコールドスタート時に取得してメモリにキャッシュする。

---

## 3. データモデル（DynamoDB）

テーブルは 1 つ（シングルテーブル設計）、課金はオンデマンド。

### 3.1 キー設計

| エンティティ | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| QR トークン | `TOKEN#<token>` | `META` | `TOKENS` | `<label>` |
| ユーザ | `USER#<userId>` | `PROFILE` | `USERS` | `<createdAt>` |
| 二つ名ロック | `EPITHET#<epithet>` | `LOCK` | – | – |
| 写真 | `PHOTO#<photoId>` | `META` | `PHOTOS#<status>` | `<createdAt>#<photoId>` |
| 設定 | `SETTINGS` | `GLOBAL` | – | – |
| 通し番号カウンタ | `COUNTER` | `TOKEN_LABEL` | – | – |

- **GSI1**: 一覧取得用（トークン一覧・ユーザ一覧・状態別の写真一覧を時系列で）。
- **GSI2**: ユーザ別の写真一覧。写真のみ `GSI2PK = USER#<uploaderId>`, `GSI2SK = <createdAt>#<photoId>` を持つ。
- QR トークンの GSI1SK は通し番号を 6 桁ゼロ埋めした値（表示用 `label` は 3 桁）。通し番号はカウンタへのアトミック加算で採番する。
- ID は ULID（時系列ソート可能）。トークンは 128bit の暗号論的乱数を base64url（22 文字）にしたもの。

### 3.2 属性

**QR トークン**

| 属性 | 型 | 説明 |
|---|---|---|
| `token` | string | ランダムトークン |
| `label` | string | 印刷用の通し番号（例 `001`）。配布管理用 |
| `status` | `unbound` \| `bound` | 紐づけ状態 |
| `userId` | string? | 紐づけ先ユーザ |
| `createdAt` / `boundAt` | string (ISO8601) | |

**ユーザ**

| 属性 | 型 | 説明 |
|---|---|---|
| `userId` | string | ULID |
| `name` | string | 入力された名前（NFKC 正規化・前後空白除去、1〜20 文字） |
| `epithet` | string | 二つ名（例 `疾風の魔術師`） |
| `token` | string? | 紐づいている QR トークン（解除後は空） |
| `status` | `active` \| `unbound` | 紐づけ解除されたら `unbound`（セッション無効化） |
| `uploadCount` | number | アップロード数（検閲待ち＋公開済み。却下・削除で減算） |
| `approvedCount` | number | 公開済み写真数 |
| `createdAt` / `updatedAt` | string | |

表示名は `〈二つ名〉名前`（例 `〈疾風の魔術師〉田中`）。

**写真**

| 属性 | 型 | 説明 |
|---|---|---|
| `photoId` | string | ULID |
| `uploaderId` | string | アップロードしたユーザ |
| `status` | `pending` \| `approved` \| `rejected` | 状態 |
| `createdAt` / `reviewedAt` | string | |

- 却下時は S3 のオブジェクトを削除し、レコードは `rejected` で残す（監査用）。
- 管理者による削除（公開済み写真）はオブジェクトとレコードを両方削除する。

**設定**

| 属性 | 型 | 説明 |
|---|---|---|
| `moderation` | `pre` \| `post` | `pre`: 管理者承認後に公開（既定） / `post`: 即時公開・事後削除 |

### 3.3 整合性

- 初回登録は `TransactWriteItems` で「トークン `unbound → bound`（条件付き）」「ユーザ作成」「二つ名ロック作成（存在しないこと）」を同時に行う。二重登録・二つ名重複を防ぐ。
- 写真の状態遷移とカウンタ増減も同一トランザクションで行い、数のずれを防ぐ。

---

## 4. 認証・セッション

### 4.1 参加者

- QR 認証成功時に API が `session` Cookie を発行する。
  - 形式: `<base64url(JSON)>.<base64url(HMAC-SHA256)>`。JSON は `{ uid, tok, iat }`（ユーザ ID・QR トークン・発行時刻）
  - 署名鍵は `SESSION_SECRET`。署名が合わない Cookie は未ログインとして扱うため、中身を書き換えてのなりすましはできない
  - 属性: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30日`。`iat` から 30 日を過ぎたものもサーバ側で拒否する
- API は毎リクエストでユーザレコードを読み、`status = active` かつ `token` が Cookie の `tok` と一致することを確認する。紐づけ解除・再紐づけされたユーザの古い Cookie は 401 となり、SPA は QR 読み込みを促す。
- 署名鍵を変更すると、発行済みの Cookie はすべて無効になる（全員が再ログイン）。
- 更新系 API は `Content-Type: application/json` のみ受け付ける。クロスオリジンからの JSON 送信はプリフライトが必要になるため、`SameSite=Lax` と合わせて CSRF 対策とする。
- 同時に **CloudFront 署名付き Cookie**（`CloudFront-Policy` / `CloudFront-Signature` / `CloudFront-Key-Pair-Id`、`Path=/photos/approved/`、有効期限 12 時間）を発行する。`GET /api/me` を呼ぶたびに再発行する（参加者画面は表示時に必ず呼ぶ）。
- Cookie を失った場合（ブラウザ変更・アプリ内ブラウザ等）は QR を再度読み込めばログインできる。

> **注意（運用）**: LINE 等のアプリ内 QR リーダーで開くとアプリ内ブラウザに Cookie が保存され、Safari/Chrome では未ログインになる。案内で「標準カメラで読み込む」ことを周知し、アプリ内ブラウザを検知した場合は注意文を表示する。

### 4.2 管理者

- `/admin` 画面でパスワードを入力 → `POST /api/admin/login` で `ADMIN_PASSWORD` と定数時間比較。
- 成功時に `admin_session` Cookie（`{ adm: true, iat }` を `SESSION_SECRET` で HMAC 署名、`HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=12時間`）を発行。
- パスワードの総当たりは API Gateway の `$default` ステージのスロットリング（50 rps / バースト 100）で緩和する。

---

## 5. 主要フロー

### 5.1 QR ログイン / 初回登録

```mermaid
sequenceDiagram
  actor U as 参加者
  participant S as SPA
  participant A as API
  participant D as DynamoDB

  U->>S: QR 読み込み（/q/<token> を開く）
  S->>A: POST /api/auth/qr {token}
  A->>D: TOKEN#<token> 取得
  alt トークンが存在しない
    A-->>S: 404（無効な QR）
  else 紐づけ済み
    A-->>S: 200 {user} + session / CloudFront Cookie
    S-->>U: ホーム画面へ
  else 未紐づけ
    A-->>S: 200 {status: "unbound"}
    S-->>U: 名前入力フォーム
    U->>S: 名前を入力
    S->>A: POST /api/auth/register {token, name}
    A->>A: 二つ名を抽選
    A->>D: TransactWrite（トークン bound / ユーザ作成 / 二つ名ロック）
    Note over A,D: 二つ名衝突時は再抽選して再試行
    A-->>S: 201 {user} + Cookie
    S-->>U: 「あなたの二つ名は〈…〉です」
  end
```

### 5.2 二つ名の生成

- 「形容」リストと「称号」リストを用意し、組み合わせて生成する（例: `疾風の` + `魔術師` → `疾風の魔術師`）。
- 各 50 語程度で 2,500 通りあり、80 名なら衝突はまれ。衝突時は再抽選（最大 10 回）。
- 単語リストはコード内の定数（`packages/shared`）として管理し、社内向けに不快感のない語を選ぶ。
- 管理者による変更時は、旧ロック削除・新ロック作成・ユーザ更新を 1 トランザクションで行う。

### 5.3 写真アップロード

```mermaid
sequenceDiagram
  actor U as 参加者
  participant S as SPA
  participant A as API
  participant P as S3 photos
  participant I as photo-ingest
  participant D as DynamoDB

  U->>S: 撮影（カメラアプリ起動）
  S->>S: HEIC→JPEG 変換（必要時）<br/>本体: 長辺1600px / サムネ: 長辺400px に縮小・再エンコード
  S->>A: POST /api/photos/upload-url
  A-->>S: {photoId, full: 署名付きPOST, thumb: 署名付きPOST}
  S->>P: thumb.jpg を POST
  S->>P: full.jpg を POST
  P-)I: ObjectCreated (photos/pending/<photoId>/full.jpg)
  I->>P: HeadObject（本体・サムネイルのアップロード者メタデータが一致するか確認）
  I->>D: 写真レコード作成 + uploadCount 加算（条件付き・冪等）
  alt moderation = post（即時公開）
    I->>P: photos/approved/ へコピー、photos/pending/ を削除
    I->>D: status=approved, approvedCount 加算
  end
  S->>A: GET /api/photos/mine（状態確認）
```

- **撮影**: `<input type="file" accept="image/*" capture="environment">` で端末のカメラアプリを起動する（`getUserMedia` による自前カメラ UI は将来の拡張）。
- **ブラウザ側処理**
  - HEIC は [heic2any](https://github.com/alexcorvi/heic2any)（libheif WASM）で JPEG に変換。サイズが大きいため HEIC 検出時のみ遅延読み込みする。
  - Canvas で縮小・JPEG 再エンコード（本体 品質 0.8 / サムネ 品質 0.7）。再エンコードにより EXIF（位置情報含む）は除去される。
  - 変換・縮小に失敗した場合は **元画像を送らず** エラーを表示する。
- **署名付き POST の条件**（有効期限 5 分）
  - オブジェクトキー固定: `photos/pending/<photoId>/full.jpg` / `photos/pending/<photoId>/thumb.jpg`
  - `Content-Type = image/jpeg`
  - `content-length-range`: 本体 ≤ 5MB、サムネ ≤ 500KB
  - メタデータ `x-amz-meta-uploader = <userId>` を固定（ingest で照合）
- **再送**: 送信待ちの画像を IndexedDB に保持し、失敗時・`online` イベント時に自動で再送する（会場の通信混雑対策）。
- photos バケットには POST を許可する CORS を設定する。オリジンは `*`（バケットの CORS にディストリビューションのドメインを入れると CDK で循環参照になるため）。POST は API が署名したポリシーが無いと受け付けられないので、オリジンを絞らなくても任意のアップロードはできない。
- 取り込み時は、アップロード者が有効なユーザであること、本体とサムネイルのアップロード者が一致することを確認する。条件を満たさないアップロードは登録しない（S3 には残る）。
- 同じ S3 イベントが重複して届いても、写真レコードの条件付き作成によりカウンタは 1 回だけ増える。

### 5.4 検閲・削除

| 操作 | 処理 |
|---|---|
| 承認 | `pending/` → `approved/` へコピー → DB を `status=approved`・`approvedCount` 加算 → `pending/` を削除（DB 更新に失敗しても画像が失われない順序） |
| 却下 | DB を `status=rejected`・`uploadCount` 減算 → `pending/` のオブジェクトを削除 |
| 削除（公開済み） | DB からレコードを削除・`uploadCount`・`approvedCount` 減算 → `approved/` のオブジェクトを削除 → CloudFront の `/photos/approved/<photoId>/*` を Invalidation |

検閲待ちの写真は削除ではなく却下する（削除 API は公開済みのみ受け付ける）。

- 検閲待ち写真は管理者・本人にのみ、API が発行する **CloudFront 署名付き URL**（有効期限 10 分）で表示する。
- 公開済み写真は `Cache-Control: max-age=3600` で保存する（`private` にすると CloudFront でキャッシュされず、S3 への GET が増えるため）。削除後もブラウザには最大 1 時間残り得る。

### 5.5 ギャラリー

- `GET /api/photos?cursor=` で公開済み写真を新しい順にページング取得（GSI1 `PHOTOS#approved`）。
- 画像は `/photos/approved/<photoId>/thumb.jpg`（一覧）・`full.jpg`（詳細）を署名付き Cookie で読み込む。
- 新着反映は 20 秒間隔のポーリング（タブ非表示中は停止）。
- 管理画面は管理者が参加者 Cookie を持たないため、状態にかかわらずすべて署名付き URL（有効期限 10 分）で表示する。

---

## 6. API 一覧

すべて `/api` 配下、JSON。参加者 API は `session` Cookie、管理者 API は `admin_session` Cookie が必要。

### 6.1 参加者

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/auth/qr` | トークンでログイン。未紐づけなら `unbound` を返す |
| POST | `/api/auth/register` | 未紐づけトークンに名前を登録（二つ名自動付与） |
| POST | `/api/auth/logout` | Cookie 削除 |
| GET | `/api/me` | 自分の情報（表示名・アップロード数）。CloudFront Cookie の再発行 |
| POST | `/api/photos/upload-url` | アップロード用署名付き POST を発行 |
| GET | `/api/photos` | 公開済み写真一覧（アップロード者の表示名付き） |
| GET | `/api/photos/mine` | 自分の写真一覧（検閲待ちは署名付き URL 付き） |

### 6.2 管理者

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/admin/login` | パスワードでログイン |
| POST | `/api/admin/logout` | Cookie 削除 |
| POST | `/api/admin/tokens` | QR トークンを N 件発行 `{count}` |
| GET | `/api/admin/tokens` | トークン一覧（印刷・配布管理用） |
| GET | `/api/admin/users` | ユーザ一覧（アップロード数付き） |
| PATCH | `/api/admin/users/{userId}` | 名前・二つ名の変更 |
| POST | `/api/admin/users/{userId}/unbind` | QR との紐づけ解除 |
| GET | `/api/admin/photos?status=` | 状態別写真一覧（検閲待ちは署名付き URL 付き） |
| POST | `/api/admin/photos/{photoId}/approve` | 承認 |
| POST | `/api/admin/photos/{photoId}/reject` | 却下 |
| DELETE | `/api/admin/photos/{photoId}` | 削除 |
| GET / PUT | `/api/admin/settings` | 設定（`moderation`）の取得・更新 |

### 6.3 紐づけ解除の挙動

- トークンを `unbound` に戻し、ユーザを `status=unbound`・`token` 空にする（1 トランザクション）。
- 該当ユーザの既存セッションは次回 API 呼び出しで 401 となる。
- ユーザレコード・二つ名ロック・写真は残す（アップロード者の表示を維持）。
- 解除したトークンは再度読み込むと新規ユーザとして登録できる。

---

## 7. 画面

### 7.1 参加者

| パス | 画面 | 内容 |
|---|---|---|
| `/q/:token` | QR 着地 | ログイン処理 → 未紐づけなら名前入力、紐づけ済みならホームへ |
| `/` | ホーム | 表示名・アップロード数・撮影ボタン・ギャラリーへの導線。未ログイン時は「QR を読み込んでください」 |
| `/gallery` | ギャラリー | 公開済み写真のグリッド表示、タップで拡大（アップロード者表示） |
| `/mine` | 自分の写真 | 自分のアップロード一覧と状態（検閲待ち／公開／却下）、送信待ちキュー |

### 7.2 管理者

| パス | 画面 | 内容 |
|---|---|---|
| `/admin/login` | ログイン | パスワード入力 |
| `/admin/users` | ユーザ管理 | 一覧（表示名・アップロード数・公開数）、名前／二つ名の編集、紐づけ解除 |
| `/admin/tokens` | QR 管理 | トークン発行、紐づけ状況、印刷用ページ |
| `/admin/tokens/print` | QR 印刷 | QR と通し番号を並べたページ。ブラウザの印刷機能で PDF 化 |
| `/admin/photos` | 検閲・写真管理 | 検閲待ちの承認／却下、公開済みの削除 |
| `/admin/settings` | 設定 | 検閲モード（事前承認／即時公開）の切り替え |

---

## 8. 非機能

### 8.1 コスト（80 名・1 イベント）

ブラウザ側圧縮（本体 500KB + サムネ 50KB）と CloudFront 配信を前提とした概算。

| シナリオ | 枚数 | 保存 | 配信 | 月額目安 |
|---|---|---|---|---|
| 少なめ（5 枚/人） | 400 | 0.2GB | 3GB | ほぼ 0 円 |
| 普通（20 枚/人） | 1,600 | 0.9GB | 40GB | 15 円前後 |
| 多め（50 枚/人） | 4,000 | 2.2GB | 100GB | 20 円前後 |

- CloudFront の無料枠（1TB/月）・Lambda / DynamoDB の無料枠はアカウント単位。既存アカウントで他システムが使用している場合は超過分が課金される（普通シナリオで数百円程度）。
- 独自ドメインを使う場合は Route 53 ホストゾーン $0.5/月。
- AWS Budgets で月 $5 超過時に通知するアラートを設定する。

### 8.2 運用・その他

- すべてのリソースに `Project=partally` タグを付与し、コストを分離する。
- 事前に数名でリハーサルし、会場の通信状況を確認する。QR は予備を印刷しておく。
- API Gateway のステージ全体にスロットリング（例: 50 rps / バースト 100）を設定する。

---

## 9. 今後の拡張

- **ポイント・余興イベント集計**: `EVENT#<eventId>`・ポイント台帳（`USER#<userId>` / `POINT#<timestamp>`）を同テーブルに追加する想定。ランキングはユーザレコード上の合計値カウンタ＋GSI で取得。
- **自前カメラ UI**: `getUserMedia` でフレーム・スタンプ合成撮影。
- **写真の保存期間**: S3 ライフサイクルルールで自動削除。
- **会場スクリーン表示**: 公開写真のスライドショー、ランキング表示。

---

## 10. リポジトリ構成（予定）

npm workspaces によるモノレポ。

```
partally/
├── docs/            設計書
├── infra/           AWS CDK（TypeScript）
├── api/             Lambda（api / photo-ingest）
├── web/             SPA（Vite + React）
└── packages/
    └── shared/      型定義・入力検証（zod）・二つ名単語リスト
```

---

## 11. 未決事項

| # | 内容 | 状態 |
|---|---|---|
| Q-1 | 写真の保存期間・ダウンロード可否・肖像権の扱い | 別途検討 |
| Q-2 | 独自ドメインを使うか（CloudFront 既定ドメインで開始可能） | 未定 |
| Q-3 | 二つ名の単語リストの内容 | 実装時に案を作成 |
| Q-4 | アップロード数に却下分を含めるか（現設計: 含めない） | 要確認 |
| Q-5 | 1 ユーザあたりのアップロード上限を設けるか | 要確認 |
