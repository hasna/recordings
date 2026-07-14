import { describe, expect, test } from "bun:test";
import { RecordingsV1Client } from "./v1.generated.js";

describe("RecordingsV1Client query serialization", () => {
  test("explodes array query parameters into repeated values", async () => {
    let requestedUrl = "";
    const client = new RecordingsV1Client({
      baseUrl: "https://recordings.example.test",
      fetch: (async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ recordings: [], count: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await client.listRecordings({ tags: ["work", "urgent"], limit: 5 });

    const url = new URL(requestedUrl);
    expect(url.searchParams.getAll("tags")).toEqual(["work", "urgent"]);
    expect(url.searchParams.get("limit")).toBe("5");
  });
});
