import { describe, expect, test } from "bun:test";
import { contentForLegacyDatabaseScan } from "../../scripts/release-guard";

describe("release guard database marker exception", () => {
  const publicCa = [
    "/etc/ssl/certs/rds-global-bundle.pem",
    "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
  ].join("\n");

  test("removes only the exact approved public CA locations in Dockerfile.package", () => {
    expect(contentForLegacyDatabaseScan("Dockerfile.package", publicCa)).not.toMatch(/\brds\b/i);
    expect(
      contentForLegacyDatabaseScan("Dockerfile.package", `${publicCa}\nRUN echo rds\n`),
    ).toMatch(/\brds\b/i);
  });

  test("does not exempt the public CA tokens outside Dockerfile.package", () => {
    expect(contentForLegacyDatabaseScan("README.md", publicCa)).toMatch(/\brds\b/i);
  });
});
