import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { PartallyStack } from "../lib/partally-stack.js";

describe("PartallyStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new PartallyStack(app, "Test", {
      env: { account: "123456789012", region: "ap-northeast-1" },
      adminPassword: "pw",
      sessionSecretParam: "/partally/session-secret",
      cloudfrontPrivateKeyParam: "/partally/cloudfront-private-key",
      budgetEmail: "ops@example.com",
    });
    template = Template.fromStack(stack);
  }, 120_000);

  it("DynamoDB はオンデマンドで GSI を 2 つ持つ", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      BillingMode: "PAY_PER_REQUEST",
      GlobalSecondaryIndexes: [
        Match.objectLike({ IndexName: "GSI1" }),
        Match.objectLike({ IndexName: "GSI2" }),
      ],
    });
  });

  it("API の Lambda に必要な環境変数を渡す", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Environment: {
        Variables: Match.objectLike({
          ADMIN_PASSWORD: "pw",
          SESSION_SECRET_PARAM: "/partally/session-secret",
          CLOUDFRONT_PRIVATE_KEY_PARAM: "/partally/cloudfront-private-key",
          CLOUDFRONT_KEY_PAIR_ID: Match.anyValue(),
          TABLE_NAME: Match.anyValue(),
          PHOTO_BUCKET: Match.anyValue(),
          DISTRIBUTION_ID: Match.anyValue(),
        }),
      },
    });
  });

  it("写真バケットは非公開で、POST の CORS だけを許可する", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedMethods: ["POST"] })] },
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicPolicy: true }),
    });
  });

  it("検閲待ちの本体画像が置かれたら取り込み Lambda を呼ぶ", () => {
    template.hasResourceProperties("Custom::S3BucketNotifications", {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          Match.objectLike({
            Events: ["s3:ObjectCreated:*"],
            Filter: {
              Key: {
                FilterRules: Match.arrayWith([
                  { Name: "suffix", Value: "/full.jpg" },
                  { Name: "prefix", Value: "photos/pending/" },
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
    for (const pattern of ["/photos/approved/*", "/photos/pending/*"]) {
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
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
    });
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

  it("予算アラートを作成する", () => {
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: "USD" } }),
    });
  });
});
