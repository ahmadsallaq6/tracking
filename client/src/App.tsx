import { FormEvent, useEffect, useMemo, useState } from "react";

type Role = "user" | "assistant";

type ToolStatus = "used" | "attempted" | "not_configured" | "error" | "skipped";

interface ToolUsage {
  linkup?: {
    status: ToolStatus;
    results?: number;
  };
}

interface Message {
  role: Role;
  content: string;
  tools?: ToolUsage;
}

const examples = [
  "Buy 10 AAPL at 192.50 on 2026-01-20",
  "Sell 5 TSLA at 210",
  "Summarize my trades",
  "Summarize AAPL trades from 2025-12-01 to 2026-01-20",
];

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const stored = window.localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      return;
    }
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;
    setTheme(prefersDark ? "dark" : "light");
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  const latestToolUsage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant" && messages[i].tools) {
        return messages[i].tools;
      }
    }
    return null;
  }, [messages]);

  const canSend = useMemo(
    () => input.trim().length > 0 && !isSending,
    [input, isSending]
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) {
      return;
    }

    const message = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setIsSending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = (await response.json()) as {
        reply?: string;
        tools?: ToolUsage;
      };
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply ?? "No response.",
          tools: data.tools,
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I couldn't reach the server.",
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="app">
      <header className="app__header">
        <div className="header__title">
          <span className="header__eyebrow">Trade Tracking Assistant</span>
          <h1>Trade Log Assistant</h1>
          <p>Log trades, get summaries, and track tool activity in one place.</p>
        </div>
        <div className="header__status">
          <button
            type="button"
            className="theme-toggle"
            onClick={() =>
              setTheme((prev) => (prev === "light" ? "dark" : "light"))
            }
            aria-label="Toggle light and dark theme"
          >
            <span className="theme-toggle__label">Theme</span>
            <span className="theme-toggle__value">
              {theme === "light" ? "Light" : "Dark"}
            </span>
          </button>
          <div className="status-card">
            <span className="status-card__label">Tool activity</span>
            <span className="status-card__value">
              {latestToolUsage?.linkup?.status
                ? `Linkup: ${latestToolUsage.linkup.status.replace(/_/g, " ")}`
                : "No activity yet"}
            </span>
            {latestToolUsage?.linkup?.results ? (
              <span className="status-card__meta">
                {latestToolUsage.linkup.results} results
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <main className="app__main">
        <section className="chat">
          {messages.length === 0 ? (
            <div className="chat__empty">
              <p>Try one of these:</p>
              <ul>
                {examples.map((text) => (
                  <li key={text}>
                    <button
                      type="button"
                      onClick={() => setInput(text)}
                      className="chip"
                    >
                      {text}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="chat__messages">
              {messages.map((msg, idx) => (
                <div
                  key={`${msg.role}-${idx}`}
                  className={`message message--${msg.role}`}
                >
                  <span className="message__role">{msg.role}</span>
                  <p>{msg.content}</p>
                  {msg.role === "assistant" ? (
                    <div className="message__tools">
                      <span className="tool-pill">
                        Linkup
                        <span className="tool-pill__status">
                          {msg.tools?.linkup?.status
                            ? msg.tools.linkup.status.replace(/_/g, " ")
                            : "skipped"}
                        </span>
                        {msg.tools?.linkup?.results ? (
                          <span className="tool-pill__meta">
                            {msg.tools.linkup.results} results
                          </span>
                        ) : null}
                      </span>
                    </div>
                  ) : null}
                </div>
              ))}
              {isSending && (
                <div className="message message--assistant">
                  <span className="message__role">assistant</span>
                  <p>Working on it...</p>
                  <div className="message__tools">
                    <span className="tool-pill">
                      Linkup
                      <span className="tool-pill__status">pending</span>
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <form className="composer" onSubmit={handleSubmit}>
          <div className="composer__field">
            <input
              type="text"
              placeholder="Type a trade or ask for a summary"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </div>
          <button type="submit" disabled={!canSend}>
            {isSending ? "Sending..." : "Send"}
          </button>
        </form>
      </main>
    </div>
  );
}
