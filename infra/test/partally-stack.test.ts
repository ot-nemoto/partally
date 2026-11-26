import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  ORIGIN_VERIFY_HEADER,
  PartallyStack,
  RESET_FUNCTION_NAME,
} from "../lib/partally-stack.js";

describe("PartallyStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new PartallyStack(app, "Test", {
      env: { account: "123456789012", region: "ap-northeast-1" },
      sessionSecretParam: "/partally/session-secret",
      adminPasswordParam: "/partally/admin-password",
      cloudfrontPrivateKeyParam: "/partally/cloudfront-private-key",
      originVerifyParam: "/partally/origin-verify",
      budgetEmail: "ops@example.com",
    });
    template = Template.fromStack(stack);
  }, 120_000);

  it("DynamoDB はオンデマンドで GSI を 2 つ持つ", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      BillingMode: "PAY_PER_REQUEST",
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "GSI1" }), Match.objectLike({ IndexName: "GSI2" })],
    });
  });

  it("API の Lambda に必要な環境変数を渡す", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Environment: {
        Variables: Match.objectLike({
          ADMIN_PASSWORD_PARAM: "/partally/admin-password",
          SESSION_SECRET_PARAM: "/partally/session-secret",
          CLOUDFRONT_PRIVATE_KEY_PARAM: "/partally/cloudfront-private-key",
          ORIGIN_VERIFY_PARAM: "/partally/origin-verify",
          CLOUDFRONT_KEY_PAIR_ID: Match.anyValue(),
          TABLE_NAME: Match.anyValue(),
          PHOTO_BUCKET: Match.anyValue(),
          DISTRIBUTION_ID: Match.anyValue(),
        }),
      },
    });
  });

  it("管理者パスワードは値を環境変数に入れず、API の Lambda が SSM のパラメータを読む", () => {
    for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
      expect(Object.keys(fn.Properties?.Environment?.Variables ?? {})).not.toContain("ADMIN_PASSWORD");
    }
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ssm:GetParameter"]),
            Resource: Match.objectLike({
              "Fn::Join": Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp(":parameter/partally/admin-password$")]),
              ]),
            }),
          }),
        ]),
      },
    });
  });

  it("管理者パスワードのパラメータ名は、デプロイの CI と GitHub Actions のロールの権限と同じ", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    const param = JSON.parse(read("../cdk.json")).context.adminPasswordParam;
    expect(param).toBe("/partally/admin-password");
    expect(read("../github-oidc.yaml")).toContain(`:parameter${param}`);
    expect(read("../../.github/workflows/ci.yml")).toContain("adminPasswordParam");
  });

  it("CloudFront は API へのリクエストに秘密の値のヘッダを付ける（値はカスタムリソースが作り、テンプレートには入らない）", () => {
    const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution"));
    const apiOrigin = distribution!.Properties.DistributionConfig.Origins.find(
      (o: { CustomOriginConfig?: unknown }) => o.CustomOriginConfig,
    );
    expect(apiOrigin.OriginCustomHeaders).toEqual([
      {
        HeaderName: ORIGIN_VERIFY_HEADER,
        HeaderValue: { "Fn::GetAtt": [expect.stringMatching(/^OriginSecret/), "Secret"] },
      },
    ]);
    template.hasResourceProperties("AWS::CloudFormation::CustomResource", { ParameterName: "/partally/origin-verify" });
  });

  it("読み込み元を絞る CSP を（報告だけでなく）強制で付け、違反を /api/csp-report に送らせる", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: { ContentSecurityPolicy: contentSecurityPolicy("ap-northeast-1"), Override: true },
        }),
      }),
    });
    const policy = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
    expect(JSON.stringify(policy)).not.toContain("Content-Security-Policy-Report-Only");
    const csp = contentSecurityPolicy("ap-northeast-1");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("report-uri /api/csp-report");
    expect(csp).toContain("https://*.s3.ap-northeast-1.amazonaws.com");
  });

  it("API のヘッダの名前は、API（app.ts）と同じ", () => {
    const app = readFileSync(new URL("../../api/src/app.ts", import.meta.url), "utf8");
    expect(app).toContain(`"${ORIGIN_VERIFY_HEADER.toLowerCase()}"`);
  });

  it("写真バケットは非公開で、POST の CORS だけを許可し、受け口の残りを 1 日で消す", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedMethods: ["POST"] })] },
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicPolicy: true }),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ Prefix: "uploads/", ExpirationInDays: 1 })]),
      },
    });
  });

  it("受け口（uploads/）に本体画像が置かれたら取り込み Lambda を呼ぶ", () => {
    template.hasResourceProperties("Custom::S3BucketNotifications", {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          Match.objectLike({
            Events: ["s3:ObjectCreated:*"],
            Filter: {
              Key: {
                FilterRules: Match.arrayWith([
                  { Name: "suffix", Value: "/full.jpg" },
                  { Name: "prefix", Value: "uploads/" },
                ]),
              },
            },
          }),
        ],
      },
    });
  });

  it("CloudFront の写真パスは鍵グループによる署名が必要", () => {
    const dists = template.findResources("AWS::CloudFront::Distribution");
    const config = Object.values(dists)[0]!.Properties.DistributionConfig;
    for (const pattern of ["/photos/approved/*", "/photos/pending/*", "/prizes/*"]) {
      const behavior = config.CacheBehaviors.find((b: any) => b.PathPattern === pattern);
      expect(behavior.TrustedKeyGroups).toHaveLength(1);
    }
    template.resourceCountIs("AWS::CloudFront::KeyGroup", 1);
    template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
      ParameterName: "/partally/cloudfront-private-key",
    });
  });

  it("HTTP API の $default ステージにスロットリングを設定する", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: { ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 },
    });
  });

  it("管理者のログインは別のルートにし、低い上限を付ける（パスワードの総当たりを抑える）", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /api/admin/login" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      RouteSettings: { "POST /api/admin/login": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 } },
    });
    // ステージはログインのルートができてから作る（無いルートの設定はデプロイで失敗する）
    const stage = Object.values(template.findResources("AWS::ApiGatewayV2::Stage"))[0] as { DependsOn?: string[] };
    const route = Object.entries(template.findResources("AWS::ApiGatewayV2::Route")).find(
      ([, r]) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey === "POST /api/admin/login",
    )?.[0];
    expect(stage.DependsOn).toContain(route);
  });

  it("CloudFront は /api/* をキャッシュせず API Gateway に送り、既定は SPA 書き換え付きで S3 に送る", () => {
    const dists = template.findResources("AWS::CloudFront::Distribution");
    const config = Object.values(dists)[0]!.Properties.DistributionConfig;

    const api = config.CacheBehaviors.find((b: any) => b.PathPattern === "/api/*");
    expect(api.AllowedMethods).toContain("POST");
    expect(api.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad"); // CachingDisabled
    expect(config.DefaultCacheBehavior.FunctionAssociations[0].EventType).toBe("viewer-request");
  });

  it("Web バケットは非公開", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it("初期化 Lambda は決まった関数名で、テーブル・写真バケットの削除と CloudFront の無効化だけを許可する", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "partally-reset",
      Timeout: 300,
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
          PHOTO_BUCKET: Match.anyValue(),
          DISTRIBUTION_ID: Match.anyValue(),
        }),
      },
    });
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes("ResetFunctionServiceRole"),
    );
    expect(policies).toHaveLength(1);
    const actions = (policies[0]!.Properties.PolicyDocument.Statement as { Action: string | string[] }[]).flatMap(
      (st) => st.Action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "dynamodb:BatchWriteItem",
        "dynamodb:Scan",
        "s3:ListBucket",
        "s3:DeleteObject*",
        "cloudfront:CreateInvalidation",
      ]),
    );
    // 写真の中身は読めない
    expect(actions.some((a) => a.startsWith("s3:Get"))).toBe(false);
    // 呼び出せるのは GitHub Actions のロールだけ（関数側にリソースベースの許可は付けない）
    expect(
      Object.keys(
        template.findResources("AWS::Lambda::Permission", {
          Properties: { FunctionName: Match.objectLike({ Ref: Match.stringLikeRegexp("ResetFunction") }) },
        }),
      ),
    ).toHaveLength(0);
  });

  it("初期化 Lambda の関数名は、Reset ワークフローと GitHub Actions のロールの権限と同じ", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    expect(read("../../.github/workflows/reset.yml")).toContain(`--function-name ${RESET_FUNCTION_NAME}`);
    expect(read("../github-oidc.yaml")).toContain(`:function:${RESET_FUNCTION_NAME}`);
  });

  it("予算アラートを作成する", () => {
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: "USD" } }),
    });
  });
});
