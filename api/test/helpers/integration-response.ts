import assert from "node:assert/strict";

type InjectResponse = {
  statusCode: number;
  body: string;
  json: () => unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertIntegrationResponse(
  response: InjectResponse,
  expectedStatus: number,
  step: string,
) {
  assert.equal(
    response.statusCode,
    expectedStatus,
    `${step} failed: expected HTTP ${expectedStatus}, received ${response.statusCode}. Response: ${response.body}`,
  );
  return response;
}

export function assertPersistedUuid(value: unknown, step: string): asserts value is string {
  assert.equal(typeof value, "string", `${step} did not return an ID.`);
  assert.match(value as string, UUID_PATTERN, `${step} returned an invalid persisted ID: ${String(value)}`);
}
