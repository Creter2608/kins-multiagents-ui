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
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.3,
      theme: {
        background: "#0c1322",
        foreground: "#ffffff",
        cursor: "#38bdf8",
        selectionBackground: "#1e3a8a",
        black: "#1e293b",
        red: "#f43f5e",
        green: "#10b981",
        yellow: "#fbbf24",
        blue: "#38bdf8",
        magenta: "#e879f9",
        cyan: "#22d3ee",
        white: "#ffffff",
        brightBlack: "#64748b",
        brightRed: "#fb7185",
        brightGreen: "#4ade80",
        brightYellow: "#fde047",
        brightBlue: "#60a5fa",
        brightMagenta: "#f0abfc",
        brightCyan: "#67e8f9",
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
      api.terminal
        .start()
        .then(() => {
          handleResize();
        })
        .catch((err) => {
          term.writeln(`\r\n\x1b[31m[Pty Error] Failed to launch CLI session: ${err}\x1b[0m\r\n`);
        });

      return () => {
        unsubData();
        resizeObserver.disconnect();
        term.dispose();
      };
    } else {
      term.writeln("\r\n\x1b[31m[Cockpit Error] Desktop PTY bridge (window.cockpitApi) is offline.\x1b[0m");
      term.writeln("\x1b[33mPlease ensure dist/src/preload/index.cjs was built correctly.\x1b[0m\r\n");
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
    <div className="flex-1 flex flex-col h-full bg-[#0c1322] overflow-hidden">
      {/* Terminal Top Bar */}
      <div className="h-10 px-4 bg-slate-900 border-b border-slate-700 flex items-center justify-between select-none">
        <div className="flex items-center space-x-2.5">
          <TerminalIcon className="w-4 h-4 text-sky-400" />
          <span className="text-sm font-semibold text-white">
            Antigravity CLI (agy)
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-sky-950 text-sky-300 border border-sky-600/70 font-mono font-bold">
            ConPTY Active
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleClear}
            title="Clear terminal buffer"
            className="px-2 py-1 rounded text-xs text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors flex items-center space-x-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>
          <button
            onClick={handleRestart}
            disabled={isRestarting}
            title="Restart agy session"
            className="px-2.5 py-1 rounded text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors flex items-center space-x-1 disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${isRestarting ? "animate-spin" : ""}`} />
            <span>Restart CLI</span>
          </button>
        </div>
      </div>

      {/* Embedded Terminal Canvas */}
      <div className="flex-1 p-2 overflow-hidden bg-[#0c1322]" ref={containerRef} />
    </div>
  );
};
