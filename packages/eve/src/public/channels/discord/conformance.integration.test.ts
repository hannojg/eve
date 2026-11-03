import { describeChannelConformance } from "#internal/testing/channel-conformance/conformance.js";
import { it } from "vitest";
import { channelContract } from "#internal/testing/channel-conformance/contract.js";
import { discordDriver } from "#internal/testing/channel-conformance/discord-driver.js";
import { withChannelConversation } from "#internal/testing/channel-conformance/harness.js";

describeChannelConformance("discord");

for (const name of [
  "pressing Approve clears the approval's buttons",
  "another person's rejected press leaves the approval's buttons in place",
]) {
  const rule = channelContract.find((entry) => entry.rule === name);
  if (rule === undefined) throw new Error(`Missing channel contract: ${name}`);
  it(`ephemeral prompt: ${name}`, async () => {
    const driver = discordDriver("shared", "interactions", true);
    await withChannelConversation(driver, rule.run);
  });
}
