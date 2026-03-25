"use client";

import { useState, useRef, useCallback } from "react";
import type { DetectionEvent, DetectionResult, CandidateScreenshot, PageScreenshot } from "@/lib/types";

export function Scanner() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "scanning" | "done" | "error">("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [candidates, setCandidates] = useState<CandidateScreenshot[]>([]);
  const [screenshots, setScreenshots] = useState<PageScreenshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg]);
  }, []);

  const handleScan = () => {
    if (!url.trim()) return;

    // Reset state
    setStatus("scanning");
    setLogs([]);
    setResult(null);
    setCandidates([]);
    setScreenshots([]);
    setError(null);

    // Close previous connection if any
    eventSourceRef.current?.close();

    const es = new EventSource(`/api/detect?url=${encodeURIComponent(url.trim())}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      const data: DetectionEvent = JSON.parse(event.data);

      switch (data.type) {
        case "status":
          addLog(data.message ?? "");
          break;
        case "screenshot":
          if (data.screenshot) {
            setScreenshots((prev) => [...prev, data.screenshot!]);
          }
          break;
        case "candidate":
          if (data.candidate) {
            setCandidates((prev) => [...prev, data.candidate!]);
          }
          break;
        case "result":
          setResult(data.data ?? null);
          break;
        case "error":
          setError(data.message ?? "Unknown error");
          setStatus("error");
          es.close();
          break;
        case "done":
          setStatus("done");
          es.close();
          break;
      }
    };

    es.onerror = () => {
      setError("Connection lost");
      setStatus("error");
      es.close();
    };
  };

  const handleReset = () => {
    eventSourceRef.current?.close();
    setStatus("idle");
    setLogs([]);
    setResult(null);
    setCandidates([]);
    setScreenshots([]);
    setError(null);
  };

  return (
    <div className="space-y-6">
      {/* URL Input */}
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && status !== "scanning" && handleScan()}
          placeholder="example.com"
          disabled={status === "scanning"}
          className="flex-1 px-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600 disabled:opacity-50"
        />
        {status === "idle" || status === "done" || status === "error" ? (
          <button
            onClick={handleScan}
            disabled={!url.trim()}
            className="px-5 py-2.5 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Scan
          </button>
        ) : (
          <button
            onClick={handleReset}
            className="px-5 py-2.5 bg-zinc-800 text-zinc-300 font-medium rounded-lg hover:bg-zinc-700 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Progress Log */}
      {logs.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 max-h-96 overflow-y-auto">
          <div className="space-y-1 font-mono text-sm">
            {logs.map((log, i) => (
              <div key={i} className="text-zinc-400">
                <span className="text-zinc-600 mr-2">{'>'}</span>
                {log}
              </div>
            ))}
            {status === "scanning" && (
              <div className="text-zinc-500 animate-pulse">
                <span className="text-zinc-600 mr-2">{'>'}</span>
                ...
              </div>
            )}
          </div>
        </div>
      )}

      {/* Page Screenshots */}
      {screenshots.length > 0 && (
        <div className="space-y-3">
          {screenshots.map((s, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-2">
              <div className="text-xs text-zinc-500 font-medium uppercase tracking-wide">
                {s.label}
              </div>
              <img
                src={`data:image/png;base64,${s.base64}`}
                alt={s.label}
                className="w-full rounded-lg border border-zinc-700"
              />
            </div>
          ))}
        </div>
      )}

      {/* Candidate Screenshots */}
      {candidates.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
          <div className="text-xs text-zinc-500 font-medium uppercase tracking-wide">
            Visual candidates ({candidates.length})
          </div>
          <div className="flex gap-3 flex-wrap">
            {candidates.map((c) => (
              <div
                key={c.index}
                className={`relative rounded-lg border p-1 ${
                  c.isMatch
                    ? "border-green-500 ring-2 ring-green-500/30"
                    : "border-zinc-700"
                }`}
              >
                <img
                  src={`data:image/png;base64,${c.base64}`}
                  alt={c.label}
                  className="h-16 w-auto rounded object-contain bg-zinc-800"
                />
                <div className="text-[10px] text-zinc-500 mt-1 max-w-[80px] truncate">
                  {c.isMatch ? "✓ Match" : `#${c.index}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-950/50 border border-red-900 rounded-lg p-4 text-red-300">
          {error}
        </div>
      )}

      {/* Result */}
      {result && <ResultCard result={result} />}
    </div>
  );
}

function ResultCard({ result }: { result: DetectionResult }) {
  if (!result.found) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <div className="text-lg font-medium text-zinc-300 mb-1">No chat widget detected</div>
        {result.notes && <p className="text-zinc-500 text-sm">{result.notes}</p>}
      </div>
    );
  }

  const methodLabels: Record<string, string> = {
    fingerprint: "Vendor Fingerprint",
    "iframe-domain": "Iframe Domain",
    ai: "AI Analysis",
    visual: "Visual Analysis",
    "fixed-scanner": "Position Heuristic",
  };

  const confidenceColors: Record<string, string> = {
    high: "text-green-400 bg-green-950/50 border-green-900",
    medium: "text-yellow-400 bg-yellow-950/50 border-yellow-900",
    low: "text-orange-400 bg-orange-950/50 border-orange-900",
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-lg font-medium text-zinc-100">
            {result.vendor || result.widgetType || "Chat widget"}
          </div>
          {result.widgetType && result.vendor && (
            <p className="text-zinc-400 text-sm mt-0.5">{result.widgetType}</p>
          )}
        </div>
        {result.screenshotBase64 && (
          <img
            src={`data:image/png;base64,${result.screenshotBase64}`}
            alt="Chat launcher"
            className="w-14 h-14 rounded-lg border border-zinc-700 object-contain bg-zinc-800"
          />
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <span className="text-xs px-2 py-1 rounded border bg-zinc-800 border-zinc-700 text-zinc-300">
          {methodLabels[result.method] || result.method}
        </span>
        <span
          className={`text-xs px-2 py-1 rounded border ${confidenceColors[result.confidence]}`}
        >
          {result.confidence} confidence
        </span>
      </div>

      {result.launcherSelector && (
        <div className="text-xs text-zinc-500">
          <span className="text-zinc-600">Selector:</span>{" "}
          <code className="text-zinc-400">{result.launcherSelector}</code>
        </div>
      )}

      {result.notes && (
        <p className="text-sm text-zinc-400">{result.notes}</p>
      )}

      {result.chatOpenScreenshotBase64 && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500 font-medium uppercase tracking-wide">
            Chat opened
          </div>
          <img
            src={`data:image/png;base64,${result.chatOpenScreenshotBase64}`}
            alt="Chat widget opened"
            className="w-full rounded-lg border border-zinc-700"
          />
        </div>
      )}
    </div>
  );
}
