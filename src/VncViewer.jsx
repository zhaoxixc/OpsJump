import { useEffect, useRef } from 'react';
import RFB from '@novnc/novnc';

export default function VncViewer({ sessionId, password, onStatus, expanded }) {
  const containerRef = useRef(null);
  const rfbRef = useRef(null);

  useEffect(() => {
    if (!sessionId || !containerRef.current) return undefined;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/remote/vnc/ws/${sessionId}`;
    const rfb = new RFB(containerRef.current, url, {});
    let credentialsSent = false;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = false;
    rfb.clipViewport = false;

    rfb.addEventListener('connect', () => {
      onStatus('VNC 已连接');
      try {
        rfb.focus();
      } catch {
        // ignore
      }
      window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      window.setTimeout(() => {
        try {
          rfb._windowResize?.();
        } catch {
          // ignore
        }
      }, 50);
    });
    rfb.addEventListener('disconnect', (event) => {
      const detail = event?.detail || {};
      const reason = [detail.code || '', detail.reason || detail.message || ''].filter(Boolean).join(' ');
      onStatus(reason ? `VNC 已断开 (${reason})` : 'VNC 已断开');
    });
    rfb.addEventListener('securityfailure', (event) => {
      onStatus(`VNC 认证失败: ${event.detail?.reason || '未知错误'}`);
    });
    rfb.addEventListener('credentialsrequired', () => {
      if (password && !credentialsSent) {
        credentialsSent = true;
        rfb.sendCredentials({ password });
      }
    });

    rfbRef.current = rfb;
    const resizeObserver = new ResizeObserver(() => {
      rfbRef.current?._windowResize?.();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      try {
        rfb.disconnect();
      } catch {
        // ignore
      }
      rfbRef.current = null;
    };
  }, [sessionId, password, onStatus]);

  useEffect(() => {
    if (!rfbRef.current) return;
    window.requestAnimationFrame(() => {
      try {
        rfbRef.current?._windowResize?.();
      } catch {
        // ignore
      }
      window.dispatchEvent(new Event('resize'));
    });
  }, [expanded]);

  return <div className="vnc-viewer" ref={containerRef} />;
}
