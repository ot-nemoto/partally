import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  aws_apigatewayv2 as apigw,
  aws_budgets as budgets,
  CfnOutput,
  CustomResource,
  aws_cloudfront as cloudfront,
  custom_resources as cr,
  Duration,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_apigatewayv2_integrations as integrations,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_lambda_nodejs as nodejs,
  aws_cloudfront_origins as origins,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_s3_notifications as s3n,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export interface PartallyStackProps extends StackProps {
  /** 管理者パスワード。Lambda の環境変数に入る */
  adminPassword: string;
  /** セッション署名鍵を保存した SSM SecureString の名前（デプロイ前に作成しておく） */
  sessionSecretParam: string;
  /** CloudFront 署名用の秘密鍵を保存する SSM SecureString の名前（デプロイ時に自動作成） */
  cloudfrontPrivateKeyParam: string;
  /** 指定すると月額予算アラートをこのアドレスへ送る */
  budgetEmail?: string;
  /** 月額予算アラートの閾値（USD） */
  budgetLimitUsd?: number;
}

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** 初期化 Lambda の関数名。GitHub Actions のロールの権限（infra/github-oidc.yaml）と Reset ワークフローで同じ名前を使う */
export const RESET_FUNCTION_NAME = "partally-reset";

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

    // ---- 写真（S3 + CloudFront 署名用の鍵）----
    const photoBucket = new s3.Bucket(this, "PhotoBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // ブラウザから署名付き POST で直接アップロードする。POST は署名済みポリシーが無いと受け付けられない
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: ["*"], allowedHeaders: ["*"] }],
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
        // 受け口に残ったもの（片方だけ届いた・取り込みで無視された）は 1 日で消す
        { prefix: "uploads/", expiration: Duration.days(1) },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const keyPairFunction = new nodejs.NodejsFunction(this, "CloudFrontKeyPairFunction", {
      entry: path("../lambda/cloudfront-keypair.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(30),
      bundling: { format: nodejs.OutputFormat.ESM, minify: true },
    });
    const privateKeyParamArn = this.formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: props.cloudfrontPrivateKeyParam.replace(/^\//, ""),
    });
    keyPairFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
        resources: [privateKeyParamArn],
      }),
    );
    const keyPair = new CustomResource(this, "CloudFrontKeyPair", {
      serviceToken: new cr.Provider(this, "CloudFrontKeyPairProvider", { onEventHandler: keyPairFunction })
        .serviceToken,
      properties: { ParameterName: props.cloudfrontPrivateKeyParam },
    });
    const photoPublicKey = new cloudfront.PublicKey(this, "PhotoPublicKey", {
      encodedKey: keyPair.getAttString("PublicKey"),
      comment: "partally: 写真の署名付き Cookie / URL",
    });
    const photoKeyGroup = new cloudfront.KeyGroup(this, "PhotoKeyGroup", { items: [photoPublicKey] });

    // ---- API（Lambda + HTTP API）----
    const sessionSecret = ssm.StringParameter.fromSecureStringParameterAttributes(this, "SessionSecret", {
      parameterName: props.sessionSecretParam,
    });

    const httpApi = new apigw.HttpApi(this, "HttpApi", { createDefaultStage: false });
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

    // S3 のキーは photos/... なので、パスを書き換えずにそのまま写真バケットへ送る
    const photoOrigin = origins.S3BucketOrigin.withOriginAccessControl(photoBucket);
    const photoBehavior: cloudfront.BehaviorOptions = {
      origin: photoOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      trustedKeyGroups: [photoKeyGroup],
    };

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        // 公開済みは署名付き Cookie、検閲待ちは署名付き URL が無いと 403 になる
        "/photos/approved/*": photoBehavior,
        "/photos/pending/*": photoBehavior,
      },
    });

    // ---- Lambda ----
    const commonEnv = {
      TABLE_NAME: table.tableName,
      PHOTO_BUCKET: photoBucket.bucketName,
      DISTRIBUTION_ID: distribution.distributionId,
      NODE_OPTIONS: "--enable-source-maps",
    };
    const bundling: nodejs.BundlingOptions = {
      format: nodejs.OutputFormat.ESM,
      minify: true,
      sourceMap: true,
      // ESM バンドル内で CommonJS 依存が require を使えるようにする
      banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    };

    const apiFunction = new nodejs.NodejsFunction(this, "ApiFunction", {
      entry: path("../../api/src/lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      environment: {
        ...commonEnv,
        ADMIN_PASSWORD: props.adminPassword,
        SESSION_SECRET_PARAM: props.sessionSecretParam,
        CLOUDFRONT_PRIVATE_KEY_PARAM: props.cloudfrontPrivateKeyParam,
        CLOUDFRONT_KEY_PAIR_ID: photoPublicKey.publicKeyId,
      },
      bundling,
      logGroup: new logs.LogGroup(this, "ApiLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(apiFunction);
    sessionSecret.grantRead(apiFunction);
    // 署名付き POST はこの関数の権限で S3 に書き込まれる
    photoBucket.grantReadWrite(apiFunction);
    photoBucket.grantDelete(apiFunction);
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [privateKeyParamArn] }),
    );
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
      }),
    );
    // API は起動時に秘密鍵を読むので、鍵を作ってから関数を作る
    apiFunction.node.addDependency(keyPair);

    // 関数がディストリビューション ID を参照するため、HTTP API とは別にルートを作る
    new apigw.HttpRoute(httpApi, "DefaultRoute", {
      httpApi,
      routeKey: apigw.HttpRouteKey.DEFAULT,
      integration: new integrations.HttpLambdaIntegration("ApiIntegration", apiFunction),
    });

    const ingestFunction = new nodejs.NodejsFunction(this, "PhotoIngestFunction", {
      entry: path("../../api/src/ingest-lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: commonEnv,
      bundling,
      logGroup: new logs.LogGroup(this, "PhotoIngestLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(ingestFunction);
    photoBucket.grantReadWrite(ingestFunction);
    photoBucket.grantDelete(ingestFunction);
    photoBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(ingestFunction), {
      prefix: "uploads/",
      suffix: "/full.jpg",
    });

    // 本番データの初期化。GitHub Actions の Reset ワークフローが関数名で呼ぶ（infra/github-oidc.yaml で呼び出しを許可）
    const resetFunction = new nodejs.NodejsFunction(this, "ResetFunction", {
      functionName: RESET_FUNCTION_NAME,
      entry: path("../../api/src/reset-lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.minutes(5),
      environment: commonEnv,
      bundling,
      logGroup: new logs.LogGroup(this, "ResetLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(resetFunction);
    photoBucket.grantRead(resetFunction);
    photoBucket.grantDelete(resetFunction);
    resetFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
      }),
    );

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
    new CfnOutput(this, "PhotoBucketName", { value: photoBucket.bucketName });
  }
}
