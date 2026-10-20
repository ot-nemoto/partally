import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_integrations as integrations,
  aws_budgets as budgets,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export interface PartallyStackProps extends StackProps {
  /** 管理者パスワード。Lambda の環境変数に入る */
  adminPassword: string;
  /** セッション署名鍵を保存した SSM SecureString の名前（デプロイ前に作成しておく） */
  sessionSecretParam: string;
  /** 指定すると月額予算アラートをこのアドレスへ送る */
  budgetEmail?: string;
  /** 月額予算アラートの閾値（USD） */
  budgetLimitUsd?: number;
}

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export class PartallyStack extends Stack {
  constructor(scope: Construct, id: string, props: PartallyStackProps) {
    super(scope, id, props);

    // ---- DynamoDB（キー設計は docs/design.md「3. データモデル」）----
    const table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      globalSecondaryIndexes: [
        {
          indexName: "GSI1",
          partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
        },
        {
          indexName: "GSI2",
          partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "GSI2SK", type: dynamodb.AttributeType.STRING },
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- API（Lambda + HTTP API）----
    const sessionSecret = ssm.StringParameter.fromSecureStringParameterAttributes(this, "SessionSecret", {
      parameterName: props.sessionSecretParam,
    });

    const apiFunction = new nodejs.NodejsFunction(this, "ApiFunction", {
      entry: path("../../api/src/lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        ADMIN_PASSWORD: props.adminPassword,
        SESSION_SECRET_PARAM: props.sessionSecretParam,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        minify: true,
        sourceMap: true,
        // ESM バンドル内で CommonJS 依存が require を使えるようにする
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      logGroup: new logs.LogGroup(this, "ApiLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(apiFunction);
    sessionSecret.grantRead(apiFunction);

    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      createDefaultStage: false,
      defaultIntegration: new integrations.HttpLambdaIntegration("ApiIntegration", apiFunction),
    });
    new apigw.HttpStage(this, "DefaultStage", {
      httpApi,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
    });

    // ---- 静的サイト（S3 + CloudFront）----
    const webBucket = new s3.Bucket(this, "WebBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // 拡張子のないパスは SPA の index.html を返す。/api 等の別ビヘイビアには適用しない
    const spaRewrite = new cloudfront.Function(this, "SpaRewrite", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var last = request.uri.split("/").pop();
  if (last.indexOf(".") === -1) request.uri = "/index.html";
  return request;
}`),
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    // web/dist が無い場合（npm run build 前の synth やテスト）はアップロードを省く
    const webDist = path("../../web/dist");
    if (existsSync(webDist)) {
      // ハッシュ付きファイルは長期キャッシュ、index.html は毎回確認させる
      new s3deploy.BucketDeployment(this, "DeployAssets", {
        sources: [s3deploy.Source.asset(webDist, { exclude: ["index.html"] })],
        destinationBucket: webBucket,
        cacheControl: [s3deploy.CacheControl.fromString("public, max-age=31536000, immutable")],
        prune: false,
      });
      new s3deploy.BucketDeployment(this, "DeployIndex", {
        sources: [s3deploy.Source.asset(webDist, { exclude: ["*", "!index.html"] })],
        destinationBucket: webBucket,
        cacheControl: [s3deploy.CacheControl.fromString("no-cache")],
        prune: false,
        distribution,
        distributionPaths: ["/index.html"],
      });
    }

    // ---- 予算アラート ----
    if (props.budgetEmail) {
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: props.budgetLimitUsd ?? 5, unit: "USD" },
          costFilters: { TagKeyValue: ["user:Project$partally"] },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              notificationType: "ACTUAL",
              comparisonOperator: "GREATER_THAN",
              threshold: 80,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [{ subscriptionType: "EMAIL", address: props.budgetEmail }],
          },
        ],
      });
    }

    new CfnOutput(this, "Url", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "AdminUrl", { value: `https://${distribution.distributionDomainName}/admin` });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
