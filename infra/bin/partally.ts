import { App, Tags } from "aws-cdk-lib";
import { PartallyStack } from "../lib/partally-stack.js";

const app = new App();

new PartallyStack(app, "Partally", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1",
  },
  sessionSecretParam: app.node.tryGetContext("sessionSecretParam"),
  adminPasswordParam: app.node.tryGetContext("adminPasswordParam"),
  cloudfrontPrivateKeyParam: app.node.tryGetContext("cloudfrontPrivateKeyParam"),
  originVerifyParam: app.node.tryGetContext("originVerifyParam"),
  budgetEmail: process.env.PARTALLY_BUDGET_EMAIL,
  budgetLimitUsd: process.env.PARTALLY_BUDGET_USD ? Number(process.env.PARTALLY_BUDGET_USD) : undefined,
});

Tags.of(app).add("Project", "partally");
