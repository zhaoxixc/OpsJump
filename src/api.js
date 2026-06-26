export async function apiRequest(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.code !== 0) {
    throw new Error(payload?.message || `请求失败(${response.status})`);
  }
  return payload.data;
}
