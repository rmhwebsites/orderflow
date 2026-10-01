import { describe, it, expect, vi, afterEach } from "vitest";
import { sendEmail, DEFAULT_FROM } from "./send";

function makeEnv(overrides: Record<string, unknown>): CloudflareEnv {
  return { APP_URL: "https://orderdesk.example.com", ...overrides } as unknown as CloudflareEnv;
}

function makeEmailStub() {
  return { send: vi.fn(async (_message: unknown) => ({ messageId: "msg-1" })) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendEmail (Cloudflare Email Service driver)", () => {
  it("maps options onto the Email Service builder shape", async () => {
    const email = makeEmailStub();
    const result = await sendEmail(makeEnv({ EMAIL: email }), {
      from: DEFAULT_FROM,
      to: ["a@example.com", "b@example.com"],
      subject: "Order update",
      html: "<p>Hello</p>",
      cc: ["c@example.com"],
      replyTo: "support@impactrentals.store",
    });
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send).toHaveBeenCalledWith({
      from: { name: "Order Desk", email: "orders@impactrentals.store" },
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      replyTo: "support@impactrentals.store",
      subject: "Order update",
      html: "<p>Hello</p>",
    });
    expect(result).toEqual({ id: "msg-1" });
  });

  it("passes attachments through with filename, content, MIME type, disposition", async () => {
    const email = makeEmailStub();
    await sendEmail(makeEnv({ EMAIL: email }), {
      from: DEFAULT_FROM,
      to: ["a@example.com"],
      subject: "Your PO",
      html: "<p>PO attached</p>",
      attachments: [{ filename: "po-123.pdf", content: "JVBERi0xLjQ=" }],
    });
    const message = email.send.mock.calls[0][0] as {
      attachments: { filename: string; content: string; type: string; disposition: string }[];
    };
    expect(message.attachments).toEqual([
      {
        filename: "po-123.pdf",
        content: "JVBERi0xLjQ=",
        type: "application/pdf",
        disposition: "attachment",
      },
    ]);
  });

  it("throws in production when the EMAIL binding is missing", async () => {
    await expect(
      sendEmail(makeEnv({}), {
        from: DEFAULT_FROM,
        to: ["a@example.com"],
        subject: "Hi",
        html: "<p>Hi</p>",
      }),
    ).rejects.toThrow("Email sending is not configured (EMAIL binding missing)");
  });

  it("logs the dev fallback instead of sending when APP_URL is localhost", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const email = makeEmailStub();
    const result = await sendEmail(
      makeEnv({ APP_URL: "http://localhost:3000", EMAIL: email }),
      {
        from: DEFAULT_FROM,
        to: ["a@example.com"],
        subject: "Hi",
        html: '<p><a href="http://localhost:3000/verify?token=t">Go</a></p>',
      },
    );
    expect(result).toEqual({ id: "dev-fallback" });
    expect(email.send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[email-fallback]",
      JSON.stringify({
        to: ["a@example.com"],
        subject: "Hi",
        url: "http://localhost:3000/verify?token=t",
      }),
    );
  });
});
