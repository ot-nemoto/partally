import { App, Tags } from "aws-cdk-lib";
import { PartallyStack } from "../lib/partally-stack.js";

const app = new App();

const adminPassword = process.env.PARTALLY_ADMIN_PASSWORD;
if (!adminPassword) {
  throw new Error("環境変数 PARTALLY_ADMIN_PASSWORD に管理者パスワードを設定してください");
}

new PartallyStack(app, "Partally", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1",
  },
  adminPassword,
  sessionSecretParam: app.node.tryGetContext("sessionSecretParam"),
  budgetEmail: process.env.PARTALLY_BUDGET_EMAIL,
  budgetLimitUsd: process.env.PARTALLY_BUDGET_USD ? Number(process.env.PARTALLY_BUDGET_USD) : undefined,
});

Tags.of(app).add("Project", "partally");
