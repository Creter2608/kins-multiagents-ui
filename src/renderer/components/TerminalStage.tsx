import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Terminal as TerminalIcon, RotateCw, Trash2 } from "lucide-react";

export const TerminalStage: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: "#090d16",
        foreground: "#f1f5f9",
        cursor: "#38bdf8",
        selectionBackground: "#334155",
        black: "#0f172a",
        red: "#f43f5e",
        green: "#10b981",
        yellow: "#f59e0b",
        blue: "#38bdf8",
        magenta: "#d946ef",
        cyan: "#06b6d4",
        white: "#f8fafc",
        brightBlack: "#475569",
        brightRed: "#fb7185",
        brightGreen: "#34d399",
        brightYellow: "#fbbf24",
        brightBlue: "#60a5fa",
        brightMagenta: "#e879f9",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff"
      }
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const api = window.cockpitApi;
    if (api) {
      // Connect terminal input to PTY
      term.onData((data) => {
        api.terminal.write(data);
      });

      // Connect PTY output to terminal
      const unsubData = api.terminal.onData((data) => {
        term.write(data);
      });

      // Handle resize
      const handleResize = () => {
        if (fitAddonRef.current && terminalRef.current) {
          try {
            fitAddonRef.current.fit();
            const cols = terminalRef.current.cols;
            const rows = terminalRef.current.rows;
            api.terminal.resize(cols, rows);
          } catch {
            // Ignore resize errors
          }
        }
      };

      const resizeObserver = new ResizeObserver(() => {
        handleResize();
      });
      resizeObserver.observe(containerRef.current);

      // Start PTY session
      void api.terminal.start().then(() => {
        handleResize();
      });

      return () => {
        unsubData();
        resizeObserver.disconnect();
        term.dispose();
      };
    } else {
      term.writeln("\x1b[33m[Notice] Running in standalone web mode without desktop PTY bridge.\x1b[0m");
      return () => term.dispose();
    }
  }, []);

  const handleRestart = async () => {
    setIsRestarting(true);
    try {
      if (terminalRef.current) {
        terminalRef.current.clear();
      }
      if (window.cockpitApi) {
        await window.cockpitApi.terminal.restart();
      }
    } finally {
      setIsRestarting(false);
    }
  };

  const handleClear = () => {
    if (terminalRef.current) {
      terminalRef.current.clear();
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#090d16] overflow-hidden">
      {/* Terminal Top Bar */}
      <div className="h-9 px-3.5 bg-slate-950 border-b border-slate-800/80 flex items-center justify-between select-none">
        <div className="flex items-center space-x-2">
          <TerminalIcon className="w-4 h-4 text-sky-400" />
          <span className="text-xs font-mono font-medium text-slate-300">
            Antigravity CLI (agy)
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-950 text-sky-400 border border-sky-800/60 font-mono">
            ConPTY
          </span>
        </div>

        <div className="flex items-center space-x-1.5">
          <button
            onClick={handleClear}
            title="Clear terminal buffer"
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleRestart}
            disabled={isRestarting}
            title="Restart agy session"
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${isRestarting ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Embedded Terminal Canvas */}
      <div className="flex-1 p-2 overflow-hidden" ref={containerRef} />
    </div>
  );
};
