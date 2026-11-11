import { useState } from "react";
import { createRoot } from "react-dom/client";
import PipelineScene, { type SceneAgent } from "@/components/PipelineScene";
import { createDiscussionParser, type DiscussionEvent } from "@/lib/discussion-stream";
import "./styles.css";

const agents = [
  { id: "strategist", label: "Strategist", color: "#60d9c8" },
  { id: "builder", label: "Builder", color: "#8cb4ff" },
  { id: "editor", label: "Editor", color: "#f7b476" },
] as const;

type Turn = Extract<DiscussionEvent, { type: "message" }>;
const sample: Turn[] = [
  { sequence: 1, type: "message", role: "strategist", text: "Design a community garden sign-up that works on a phone. Keep the form to a contact address, an available slot, and a confirmation." },
  { sequence: 2, type: "message", role: "builder", text: "Show available slots first. Reserve the selected slot when the form succeeds. If two visitors pick the last slot, show the remaining options to the second visitor." },
  { sequence: 3, type: "message", role: "editor", text: "Explain how the contact address will be used, and show a clear way to cancel. Test the last-slot conflict and keyboard navigation." },
  { sequence: 4, type: "message", role: "strategist", text: "Deliver one slot picker, an accessible confirmation page, and three checks: successful signup, last-slot conflict, and cancellation." },
];

function sampleStream() {
  const frames = [...sample, { type: "done" }];
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<BufferSource>({
    async pull(controller) {
      const frame = frames[index++];
      if (!frame) {
        controller.close();
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 550));
      controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
    },
  });
}

function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const active = running ? sample[turns.length]?.role : undefined;
  const sceneAgents: SceneAgent[] = agents.map((agent) => {
    const completed = turns.some((turn) => turn.role === agent.id);
    return {
      ...agent,
      status: active === agent.id ? "running" : completed ? "done" : running ? "waiting" : "idle",
      progress: active === agent.id ? 0.5 : completed ? 1 : 0,
      supports: [],
    };
  });

  async function replay() {
    setTurns([]);
    setSelected("");
    setError("");
    setRunning(true);
    const parser = createDiscussionParser((event) => {
      if (event.type === "message") setTurns((previous) => [...previous, event]);
      if (event.type === "error") setError(event.message);
    });
    const reader = sampleStream().pipeThrough(new TextDecoderStream()).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(value);
      }
      parser.finish();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Replay failed.");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      setRunning(false);
    }
  }

  return (
    <main>
      <header>
        <div>
          <h1>Think Tank Pipeline</h1>
          <p>A scripted demo of a streamed agent handoff.</p>
        </div>
        <button type="button" onClick={replay} disabled={running}>{running ? "Replaying…" : "Replay demo"}</button>
      </header>
      <div className="scene">
        <PipelineScene agents={sceneAgents} onAgentClick={(id) => setSelected(id === selected ? "" : id)} />
      </div>
      <section aria-labelledby="transcript">
        <div className="transcript-heading">
          <h2 id="transcript">Community garden sign-up</h2>
          <button type="button" className="secondary" hidden={!selected} onClick={() => setSelected("")}>Show all turns</button>
        </div>
        <div role="status">
          {error && <p>{error}</p>}
          {!turns.length && !running && <p>Start the replay to see the discussion.</p>}
          <ol>
            {turns.filter((turn) => !selected || turn.role === selected).map((turn) => (
              <li key={turn.sequence}><strong>{turn.role}</strong><p>{turn.text}</p></li>
            ))}
          </ol>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
