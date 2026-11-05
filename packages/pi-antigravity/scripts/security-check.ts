import { expect } from "bun:test";
import {
  getLastDiagnostics,
  resetDiagnosticsForTests,
  runWithDiagnostics,
  setLastEndpoint,
  setLastError,
  setLastStatus,
} from "../src/diagnostics/index.ts";
import {
  assertSafeApiBaseUrl,
  escapeHtml,
  escapeRegExp,
  maskEmail,
  redactSecrets,
  resolveCallbackHost,
} from "../src/utils/index.ts";

expect(maskEmail("user@example.com")).toBe("u***r@example.com");
expect(maskEmail("ab@example.com")).toBe("a***@example.com");
expect(maskEmail("invalid-email")).toBe("[redacted-email]");
expect(maskEmail(undefined)).toBeUndefined();

expect(resolveCallbackHost("127.0.0.1")).toBe("127.0.0.1");
expect(resolveCallbackHost("localhost")).toBe("127.0.0.1");
expect(resolveCallbackHost("::1")).toBe("::1");
expect(() => resolveCallbackHost("0.0.0.0")).toThrow(/loopback/i);
expect(() => resolveCallbackHost("192.168.1.1")).toThrow(/loopback/i);

expect(assertSafeApiBaseUrl("https://cloudcode-pa.googleapis.com/")).toBe(
  "https://cloudcode-pa.googleapis.com",
);
expect(() => assertSafeApiBaseUrl("http://cloudcode-pa.googleapis.com")).toThrow(/https/i);
expect(() => assertSafeApiBaseUrl("https://evil.example.com")).toThrow(/not allowed/i);
expect(() => assertSafeApiBaseUrl("https://user:pass@cloudcode-pa.googleapis.com")).toThrow(
  /credentials/i,
);

expect(escapeHtml(`<script>alert("x")</script>`)).toMatch(/&lt;script&gt;/);
expect(escapeRegExp("a.b*c?")).toBe(String.raw`a\.b\*c\?`);

const prefix = "ya29";
const dummyToken = [prefix, "a0AfH6SMC-test"].join(".");
const dummyToken2 = [prefix, "abc"].join(".");
const dummyRefresh = ["1", "abcdefghijklmnopqrstuvwxyz12"].join("/");
const leaked = redactSecrets(
  `Bearer ${dummyToken} token="${dummyToken2}" refresh_token=${dummyRefresh}`,
);
expect(leaked).not.toMatch(/ya29\./);
expect(leaked).not.toMatch(/1\/abcdefgh/);
expect(leaked).toMatch(/\[redacted/);

resetDiagnosticsForTests();
await Promise.all([
  runWithDiagnostics(async () => {
    setLastEndpoint("https://a.example");
    setLastStatus(200);
    await new Promise((r) => setTimeout(r, 20));
    setLastError("error-a");
  }),
  runWithDiagnostics(async () => {
    setLastEndpoint("https://b.example");
    setLastStatus(429);
    await new Promise((r) => setTimeout(r, 5));
    setLastError("error-b");
  }),
]);

const last = getLastDiagnostics();
expect(last.endpoint === "https://a.example" || last.endpoint === "https://b.example").toBe(true);
if (last.endpoint === "https://a.example") {
  expect(last.status).toBe(200);
  expect(last.error).toBe("error-a");
} else {
  expect(last.status).toBe(429);
  expect(last.error).toBe("error-b");
}

console.log("security-check: ok");
