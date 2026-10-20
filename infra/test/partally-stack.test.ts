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
          TABLE_NAME: Match.anyValue(),
        }),
      },
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
