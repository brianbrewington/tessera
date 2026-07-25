// LLM boundary — an Ollama /api/chat client for extraction (mirrors embedder.ts's HTTP shape).
// Kept behind a `Chat` interface so tests inject a deterministic stub and the extractor never
// hard-depends on a running model.

export interface Chat {
  /** Return the assistant's text for a system+user prompt. Throws on transport error. */
  complete(system: string, user: string, opts?: { temperature?: number; model?: string }): Promise<string>;
}

export class OllamaChat implements Chat {
  constructor(
    private model = "qwen2.5:14b",
    private host = "http://127.0.0.1:11434",
    private timeoutMs = 600_000,
  ) {}
  async complete(system: string, user: string, opts: { temperature?: number; model?: string } = {}): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model ?? this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          stream: false,
          options: { temperature: opts.temperature ?? 0.4 },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`ollama chat failed: ${res.status}`);
      const j = (await res.json()) as { message?: { content?: string } };
      return j.message?.content ?? "";
    } finally {
      clearTimeout(t);
    }
  }
}

/** Deterministic stub for tests: returns a canned reply (optionally keyed by a substring of the user text). */
export class StubChat implements Chat {
  constructor(private replies: string | ((user: string) => string)) {}
  async complete(_system: string, user: string): Promise<string> {
    return typeof this.replies === "function" ? this.replies(user) : this.replies;
  }
}
