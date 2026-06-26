import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

export default function SshTerminal({ sessionId, onStatus, expanded }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const socketRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    if (!sessionId || !containerRef.current) return undefined;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/remote/ssh/ws/${sessionId}`;
    const socket = new WebSocket(url);
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: {
        background: '#020617',
        foreground: '#e2e8f0',
        cursor: '#93c5fd',
      },
      scrollback: 3000,
      convertEol: true,
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    socketRef.current = socket;
    fitRef.current = fitAddon;

    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      fitAddon.fit();
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };

    terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'data', data }));
      }
    });

    socket.addEventListener('open', () => {
      onStatus('SSH 已连接');
      fitAddon.fit();
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      terminal.focus();
    });

    socket.addEventListener('message', (event) => {
      const payload = typeof event.data === 'string' ? event.data : '';
      if (!payload) return;
      try {
        const message = JSON.parse(payload);
        if (message.type === 'output') {
          terminal.write(String(message.data || ''));
        } else if (message.type === 'status' && message.data) {
          onStatus(String(message.data));
        }
      } catch {
        terminal.write(payload);
      }
    });

    socket.addEventListener('close', (event) => {
      const reason = [event.code || '', event.reason || ''].filter(Boolean).join(' ');
      onStatus(reason ? `SSH 已断开 (${reason})` : 'SSH 已断开');
    });
    socket.addEventListener('error', () => onStatus('SSH 连接失败'));

    const resizeObserver = new ResizeObserver(() => sendResize());
    resizeObserver.observe(containerRef.current);
    window.addEventListener('resize', sendResize);

    const raf = window.requestAnimationFrame(sendResize);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', sendResize);
      resizeObserver.disconnect();
      try {
        socket.close();
      } catch {
        // ignore
      }
      try {
        terminal.dispose();
      } catch {
        // ignore
      }
      terminalRef.current = null;
      socketRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, onStatus]);

  useEffect(() => {
    if (!fitRef.current || !terminalRef.current) return;
    window.requestAnimationFrame(() => {
      try {
        fitRef.current.fit();
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({ type: 'resize', cols: terminalRef.current.cols, rows: terminalRef.current.rows }));
        }
      } catch {
        // ignore
      }
    });
  }, [expanded]);

  return <div className="ssh-terminal" ref={containerRef} />;
}
