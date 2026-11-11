export type DiscussionRole = "strategist" | "builder" | "editor";
export type DiscussionEvent =
  | { type: "message"; role: DiscussionRole; text: string; sequence: number }
  | { type: "done" }
  | { type: "error"; message: string };

/** Bounded, strict framing: EOF alone must never turn a failed stream into success. */
export function createDiscussionParser(onEvent: (event: DiscussionEvent) => void) {
  const roles: DiscussionRole[] = ["strategist", "builder", "editor", "strategist"];
  let buffer = "";
  let turns = 0;
  let characters = 0;
  let terminal = false;
  function line(raw: string) {
    if (!raw.trim()) return;
    if (terminal) throw new Error("The discussion sent data after it ended.");
    let event: DiscussionEvent;
    try { event = JSON.parse(raw); }
    catch { throw new Error("The discussion returned an unreadable update. Completed turns are preserved."); }
    if (!event || typeof event !== "object") throw new Error("Invalid discussion update.");
    if (event.type === "message") {
      if (turns >= 4 || event.role !== roles[turns] || event.sequence !== turns + 1 || typeof event.text !== "string" || !event.text.trim()) {
        throw new Error("The discussion returned an invalid turn. Completed turns are preserved.");
      }
      characters += event.text.length;
      if (characters > 6000) throw new Error("The discussion exceeded its local transcript limit.");
      turns += 1;
    } else if (event.type === "done") {
      if (turns !== 4) throw new Error("The discussion ended before all four turns completed.");
      terminal = true;
    } else if (event.type === "error") {
      if (typeof event.message !== "string" || !event.message.trim() || event.message.length > 2000) throw new Error("The discussion failed without a usable error message.");
      terminal = true;
    } else throw new Error("The discussion returned an unknown update.");
    onEvent(event);
  }
  return {
    push(chunk: string) {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) !== -1) {
        const next = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (next.length > 64000) throw new Error("The discussion update is too large.");
        line(next);
      }
      if (buffer.length > 64000) throw new Error("The discussion update is too large.");
    },
    finish() {
      if (buffer.trim()) line(buffer);
      buffer = "";
      if (!terminal) throw new Error("The discussion connection ended early. Completed turns are preserved; retry when ready.");
    },
  };
}
