// Shared /api/chat client — attaches the Supabase session token when signed in.

export async function chatFetch(body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = await window.PaperStore.getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch('/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}
