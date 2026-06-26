import { useEffect, useRef, useState } from 'react';
import Guacamole from 'guacamole-common-js';

function buildQuery({ token, width, height }) {
  const params = new URLSearchParams();
  params.set('token', token);
  params.set('width', String(width));
  params.set('height', String(height));
  return params.toString();
}

export default function RdpViewer({ sessionId, connectionToken, onStatus, expanded }) {
  const wrapperRef = useRef(null);
  const displayHostRef = useRef(null);
  const [localStatus, setLocalStatus] = useState('正在初始化...');

  useEffect(() => {
    if (!connectionToken || !wrapperRef.current || !displayHostRef.current) return undefined;

    const wrapper = wrapperRef.current;
    const displayHost = displayHostRef.current;
    displayHost.replaceChildren();

    let tunnel = null;
    let client = null;
    let display = null;
    let displayElement = null;
    let remoteWidth = 0;
    let remoteHeight = 0;
    let disposed = false;
    let handshakeTimeout = null;

    const setStatus = (value) => {
      setLocalStatus(value);
      onStatus(value);
    };

    try {
      setStatus('RDP 正在连接...');
      tunnel = new Guacamole.WebSocketTunnel('/api/remote/rdp/ws');
      client = new Guacamole.Client(tunnel);
      display = client.getDisplay();
      displayElement = display.getElement();

      displayElement.classList.add('rdp-display');
      displayElement.style.touchAction = 'none';
      displayElement.style.userSelect = 'none';
      displayElement.style.webkitUserSelect = 'none';
      displayElement.style.outline = 'none';
      displayElement.style.cursor = 'none';
      displayHost.appendChild(displayElement);

      const fitDisplay = () => {
        if (!display || disposed || !remoteWidth || !remoteHeight) return;
        const hostWidth = Math.max(1, displayHost.clientWidth || wrapper.clientWidth || window.innerWidth || 1366);
        const hostHeight = Math.max(1, displayHost.clientHeight || wrapper.clientHeight || window.innerHeight || 768);
        const scale = Math.min(hostWidth / remoteWidth, hostHeight / remoteHeight);
        display.scale(scale);
      };

      const refreshViewport = () => {
        syncSize();
        fitDisplay();
      };

      const syncSize = () => {
        if (!client || disposed) return;
        const viewportWidth = displayHost.clientWidth || wrapper.clientWidth || window.innerWidth || 1366;
        const viewportHeight = displayHost.clientHeight || wrapper.clientHeight || window.innerHeight || 768;
        const width = Math.max(320, Math.floor(viewportWidth));
        const height = Math.max(240, Math.floor(viewportHeight));
        client.sendSize(width, height);
      };

      const focusWrapper = () => wrapper.focus();
      wrapper.addEventListener('pointerdown', focusWrapper);

      const mouseButtons = { left: false, middle: false, right: false };
      const getRemoteMouseState = (event) => {
        const rect = displayElement.getBoundingClientRect();
        const x = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * (remoteWidth || rect.width) : 0;
        const y = rect.height > 0 ? ((event.clientY - rect.top) / rect.height) * (remoteHeight || rect.height) : 0;
        return new Guacamole.Mouse.State({
          x: Math.max(0, Math.min(remoteWidth || rect.width, x)),
          y: Math.max(0, Math.min(remoteHeight || rect.height, y)),
          left: mouseButtons.left,
          middle: mouseButtons.middle,
          right: mouseButtons.right,
        });
      };
      const sendMouse = (event) => {
        display?.showCursor(true);
        client.sendMouseState(getRemoteMouseState(event), false);
      };
      const setMouseButton = (event, pressed) => {
        if (event.button === 0) mouseButtons.left = pressed;
        else if (event.button === 1) mouseButtons.middle = pressed;
        else if (event.button === 2) mouseButtons.right = pressed;
        sendMouse(event);
      };
      const handleMouseDown = (event) => setMouseButton(event, true);
      const handleMouseUp = (event) => setMouseButton(event, false);
      const sendWheel = (event) => {
        event.preventDefault();
        const state = getRemoteMouseState(event);
        if (event.deltaY < 0) state.up = true;
        else if (event.deltaY > 0) state.down = true;
        client.sendMouseState(state, false);
      };
      const hideCursor = () => display?.showCursor(false);
      const blockContextMenu = (event) => event.preventDefault();
      displayElement.addEventListener('mousemove', sendMouse);
      displayElement.addEventListener('mousedown', handleMouseDown);
      displayElement.addEventListener('mouseup', handleMouseUp);
      displayElement.addEventListener('mouseleave', hideCursor);
      displayElement.addEventListener('wheel', sendWheel, { passive: false });
      displayElement.addEventListener('contextmenu', blockContextMenu);

      const keyboard = new Guacamole.Keyboard(wrapper);
      keyboard.onkeydown = (keysym) => {
        client.sendKeyEvent(true, keysym);
        return false;
      };
      keyboard.onkeyup = (keysym) => {
        client.sendKeyEvent(false, keysym);
      };

      const observer = new ResizeObserver(() => syncSize());
      observer.observe(wrapper);
      window.addEventListener('resize', refreshViewport);
      handshakeTimeout = window.setTimeout(() => {
        if (!disposed) setStatus('RDP 连接超时，请确认 guacd 已启动');
      }, 15000);

      client.onstatechange = (state) => {
        if (disposed) return;
        if (state === Guacamole.Client.State.CONNECTED) {
          window.clearTimeout(handshakeTimeout);
          setStatus('RDP 已连接');
          syncSize();
          window.setTimeout(syncSize, 250);
          window.setTimeout(syncSize, 1000);
          fitDisplay();
        } else if (state === Guacamole.Client.State.CONNECTING) setStatus('RDP 正在连接...');
        else if (state === Guacamole.Client.State.WAITING) setStatus('RDP 正在协商...');
        else if (state === Guacamole.Client.State.DISCONNECTING) setStatus('RDP 正在断开...');
        else if (state === Guacamole.Client.State.DISCONNECTED) setStatus('RDP 已断开');
        else if (state === Guacamole.Client.State.IDLE) setStatus('RDP 空闲');
      };

      display.onresize = (width, height) => {
        remoteWidth = width;
        remoteHeight = height;
        fitDisplay();
        syncSize();
      };

      tunnel.onerror = (status) => {
        if (disposed) return;
        setStatus(`RDP 连接失败: ${status?.message || status?.code || 'unknown'}`);
      };

      tunnel.onstatechange = (state) => {
        if (disposed) return;
        if (state === Guacamole.Tunnel.State.CLOSED) {
          setStatus('RDP 已断开');
        }
      };

      client.connect(buildQuery({
        token: connectionToken,
        width: Math.max(320, Math.floor(displayHost.clientWidth || wrapper.clientWidth || window.innerWidth || 1366)),
        height: Math.max(240, Math.floor(displayHost.clientHeight || wrapper.clientHeight || window.innerHeight || 768)),
      }));

      return () => {
        disposed = true;
        window.clearTimeout(handshakeTimeout);
        observer.disconnect();
        window.removeEventListener('resize', refreshViewport);
        wrapper.removeEventListener('pointerdown', focusWrapper);
        displayElement.removeEventListener('mousemove', sendMouse);
        displayElement.removeEventListener('mousedown', handleMouseDown);
        displayElement.removeEventListener('mouseup', handleMouseUp);
        displayElement.removeEventListener('mouseleave', hideCursor);
        displayElement.removeEventListener('wheel', sendWheel);
        displayElement.removeEventListener('contextmenu', blockContextMenu);
        keyboard.onkeydown = null;
        keyboard.onkeyup = null;
        try {
          client.disconnect();
        } catch {
          // ignore
        }
      };
    } catch (error) {
      setStatus(`RDP 初始化失败: ${error instanceof Error ? error.message : 'unknown'}`);
      return () => {
        disposed = true;
        window.clearTimeout(handshakeTimeout);
      };
    }
  }, [connectionToken, onStatus]);

  useEffect(() => {
    if (!wrapperRef.current) return;
    wrapperRef.current.focus();
  }, [expanded, sessionId]);

  return (
    <div className="rdp-viewer" ref={wrapperRef} tabIndex={0}>
      <div className="rdp-status-pill">{localStatus}</div>
      <div className="rdp-stage" ref={displayHostRef} />
    </div>
  );
}
