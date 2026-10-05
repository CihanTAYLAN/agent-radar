import { describe, expect, it } from "vitest";
import { maskSecrets, safeText, truncate } from "../src/mask.js";

describe("maskSecrets", () => {
  it.each([
    ["key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX end", "sk-ant-api03"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end", "ghp_abcdef"],
    ["aws AKIAIOSFODNN7EXAMPLE end", "AKIAIOSFODNN7EXAMPLE"],
    ["Authorization: Bearer abcdefghijklmnop1234", "abcdefghijklmnop1234"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end", "eyJzdWIi"],
    ["slack xoxb-1234567890-abcdefghij end", "1234567890-abcdefghij"],
    ["google AIzaSyA1234567890abcdefghijklmnopqrstuv end", "AIzaSyA1234"],
  ])("masks %s", (input, leaked) => {
    const out = maskSecrets(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain("REDACTED");
  });

  it("masks KEY=/TOKEN=/PASSWORD=/SECRET= values but keeps the names", () => {
    const out = maskSecrets('API_KEY=abc123 DB_PASSWORD="hunter2 x" secret: topsecret1 "auth_token": "zzz999" harmless=visible');
    expect(out).toContain("API_KEY=[REDACTED]");
    expect(out).toContain("DB_PASSWORD=[REDACTED]");
    expect(out).not.toMatch(/abc123|hunter2|topsecret1|zzz999/);
    expect(out).toContain("harmless=visible");
  });

  it("masks whole PRIVATE KEY blocks, even unterminated ones", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(maskSecrets(`x ${pem} y`)).toBe("x [REDACTED PRIVATE KEY] y");
    expect(maskSecrets("-----BEGIN PRIVATE KEY-----\nMIIEow")).toBe("[REDACTED PRIVATE KEY]");
  });

  it("leaves ordinary text alone", () => {
    const t = "npm run build && echo done # sk is short, key words fine";
    expect(maskSecrets(t)).toBe(t);
  });
});

describe("maskSecrets: URL userinfo and password flags", () => {
  it.each([
    ["postgresql://postgres:postgres@localhost:5432/db", "postgresql://postgres:[REDACTED]@localhost:5432/db"],
    ["postgres://u:pw@h/db", "postgres://u:[REDACTED]@h/db"],
    ["mysql://root:hunter2@127.0.0.1:3306/x", "mysql://root:[REDACTED]@127.0.0.1:3306/x"],
    ["mongodb+srv://admin:s3cr3t@cluster0.example.net/test", "mongodb+srv://admin:[REDACTED]@cluster0.example.net/test"],
    ["redis://:sekret@cache:6379/0", "redis://:[REDACTED]@cache:6379/0"],
    ["rediss://default:sekret@cache:6380", "rediss://default:[REDACTED]@cache:6380"],
    ["amqp://guest:guest@rabbit:5672/", "amqp://guest:[REDACTED]@rabbit:5672/"],
    ["https://bot:tok123@example.com/path?a=b@c", "https://bot:[REDACTED]@example.com/path?a=b@c"],
    ["ftp://anon:pw@ftp.example.com", "ftp://anon:[REDACTED]@ftp.example.com"],
    ["postgres://u:p%40ss%2Fw%3Ard@h/db", "postgres://u:[REDACTED]@h/db"],
    ["postgres://u:pa:ss!$&*@h/db", "postgres://u:[REDACTED]@h/db"],
    ["postgres://u:p@ss@h/db", "postgres://u:[REDACTED]@h/db"],
    ["DATABASE_URL=postgres://u:pw@h:5432/db npm start", "DATABASE_URL=postgres://u:[REDACTED]@h:5432/db npm start"],
    ['{"url":"postgres://u:pw@h/db"}', '{"url":"postgres://u:[REDACTED]@h/db"}'],
    ["PGPASSWORD=abc123 psql -h x", "PGPASSWORD=[REDACTED] psql -h x"],
    ["mysql --password=abc123 -u root", "mysql --password=[REDACTED] -u root"],
    ["mysql --password abc123 -u root", "mysql --password [REDACTED] -u root"],
    ["mysql --password 'a b c' -u root", "mysql --password [REDACTED] -u root"],
  ])("masks %s", (input, expected) => {
    expect(maskSecrets(input)).toBe(expected);
  });

  it.each([
    "https://user@host.example.com/x",
    "git@github.com:org/repo.git",
    "ssh://git@github.com/org/repo.git",
    "localhost:5432 and 127.0.0.1:8080",
    "http://[::1]:8080/path",
    "at 12:30:45@ server, 12:30:45 done",
    "https://example.com:8443/a@b",
    "mysql -p -u root",
    "mysql --password --verbose",
    "postgres://u@h:5432/db",
  ])("leaves %s alone", (t) => {
    expect(maskSecrets(t)).toBe(t);
  });
});

describe("truncate / safeText", () => {
  it("truncates with a note and reports the original size", () => {
    const out = truncate("x".repeat(50), 10);
    expect(out.startsWith("xxxxxxxxxx\n")).toBe(true);
    expect(out).toContain("truncated 40 chars");
  });
  it("does not touch short strings", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });
  it("masks before cutting so a secret straddling the cut cannot leak", () => {
    const secret = "sk-ant-" + "A".repeat(40);
    const text = "a".repeat(95) + secret;
    const out = safeText(text, 100);
    expect(out).not.toContain("AAAA");
  });
  it("copes with huge inputs cheaply and reports the true size", () => {
    const out = safeText("z".repeat(5_000_000), 2048);
    expect(out.length).toBeLessThan(2200);
    expect(out).toContain("truncated 4997952 chars");
  });
});
