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
        background: "#000000",
        foreground: "#cccccc",
        cursor: "#4ade80",
        selectionBackground: "#333333",
        black: "#0c0c0c",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#d946ef",
        cyan: "#06b6d4",
        white: "#cccccc",
        brightBlack: "#52525b",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
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

      window.addEventListener("resize", handleResize);

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
        window.removeEventListener("resize", handleResize);
        term.dispose();
      };
    } else {
      term.writeln("\r\n\x1b[31m[Cockpit Error] Desktop PTY bridge (window.cockpitApi) is offline.\x1b[0m");
      term.writeln("\x1b[33mPlease ensure dist/src/preload/index.cjs was built correctly.\x1b[0m\r\n");
      return () => term.dispose();
    }
  }, []);

  const handleRestart = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    try {
      if (window.cockpitApi) {
        await window.cockpitApi.terminal.restart();
      }
      if (terminalRef.current) {
        terminalRef.current.clear();
      }
    } catch (err) {
      if (terminalRef.current) {
        terminalRef.current.writeln(`\r\n\x1b[31m[Restart Failed] ${err}\x1b[0m\r\n`);
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
    <div className="flex-1 flex flex-col h-full bg-[#000000] overflow-hidden">
      {/* Terminal Top Bar */}
      <div className="h-10 px-4 bg-[#0c0c0c] border-b border-[#1f1f1f] flex items-center justify-between select-none font-mono">
        <div className="flex items-center space-x-2.5">
          <TerminalIcon className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-semibold text-zinc-100">
            Antigravity CLI (agy)
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-[#141414] text-zinc-400 border border-[#27272a] font-mono font-medium">
            ConPTY Active
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleClear}
            title="Clear terminal buffer"
            className="px-2 py-1 rounded text-xs text-zinc-300 hover:text-white bg-[#141414] hover:bg-[#1f1f1f] border border-[#27272a] transition-colors flex items-center space-x-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>
          <button
            onClick={handleRestart}
            disabled={isRestarting}
            title="Restart agy session"
            className="px-2.5 py-1 rounded text-xs font-medium text-zinc-300 hover:text-white bg-[#141414] hover:bg-[#1f1f1f] border border-[#27272a] transition-colors flex items-center space-x-1 disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${isRestarting ? "animate-spin" : ""}`} />
            <span>Restart CLI</span>
          </button>
        </div>
      </div>

      {/* Embedded Terminal Canvas */}
      <div className="flex-1 p-2 overflow-hidden bg-[#000000]" ref={containerRef} />
    </div>
  );
};
