import { leaseOwnerFingerprint } from "../src/runtime/objective-lease.js";

const fp = leaseOwnerFingerprint({
  runId: "run-91ff8309-c3b6-42e8-badb-a00d947f4245",
  workstreamId: "cyber-assurance-wave1-vi-narrow-remediation-12",
  env: process.env,
});
console.log(
  JSON.stringify(
    {
      computed: fp,
      expected: "5c2140242112d19727266ba8a943319e",
      match: fp === "5c2140242112d19727266ba8a943319e",
      hint:
        process.env.CURSOR_AGENT_ID?.trim() ||
        process.env.HOSTNAME?.trim() ||
        process.env.RADIO_WORKSPACE_ID?.trim() ||
        "local",
    },
    null,
    2,
  ),
);
