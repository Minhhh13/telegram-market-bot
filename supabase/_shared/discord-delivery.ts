// A webhook is scoped to its one Discord channel. Never log its URL or token.
export function discordWebhook(value: unknown) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Discord webhook is not configured correctly'); }
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password || url.search || url.hash ||
      !/^\/api(?:\/v10)?\/webhooks\/\d{17,20}\/[A-Za-z0-9._-]{30,200}\/?$/.test(url.pathname)) {
    throw new Error('Discord webhook is not configured correctly');
  }
  const webhookId = url.pathname.split('/').filter(Boolean).at(-2)!;
  url.searchParams.set('wait', 'true');
  return { url, webhookId };
}

export const discordText = (value: unknown) => String(value)
  .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
  .replace(/<i>([\s\S]*?)<\/i>/g, '*$1*');

type DiscordOptions = { images?: Uint8Array[]; filenames?: string[]; username?: string };
export async function sendDiscordWebhook(webhookUrl: string, content: string, { images = [], filenames = [], username }: DiscordOptions = {}, fetchImpl: typeof fetch = fetch) {
  const { url, webhookId } = discordWebhook(webhookUrl);
  if (typeof content !== 'string' || !content || content.length > 2000) throw new Error('Discord message must contain at most 2000 characters');
  if (!Array.isArray(images) || images.length > 4 || images.some(bytes => !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 8_000_000))
    throw new Error('Discord chart attachments are invalid');
  const payload: Record<string, unknown> = { content, allowed_mentions: { parse: [] }, flags: 4, ...(username ? { username } : {}) };
  let body, headers;
  if (images.length) {
    const form = new FormData();
    payload.attachments = images.map((bytes, index) => {
      const filename = filenames[index] || `market-chart-${index + 1}.png`;
      if (!/^[A-Za-z0-9._-]+\.png$/.test(filename)) throw new Error('Discord chart filename is invalid');
      form.set(`files[${index}]`, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), filename);
      return { id: index, filename };
    });
    form.set('payload_json', JSON.stringify(payload));body = form;
  } else { body = JSON.stringify(payload);headers = { 'Content-Type': 'application/json' }; }
  try {
    const response = await fetchImpl(url.href, { method: 'POST', redirect: 'error', ...(headers ? { headers } : {}), body, signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok || !/^\d{17,20}$/.test(result?.id || '') || !/^\d{17,20}$/.test(result?.channel_id || '') ||
        result.webhook_id !== webhookId || images.length && (!Array.isArray(result.attachments) || result.attachments.length !== images.length)) throw new Error('Delivery rejected');
    return { platform: 'discord', messageId: result.id, channelId: result.channel_id, webhookId };
  } catch {
    // A timed-out request may have arrived. Do not retry and risk duplicate posts.
    throw new Error('Discord delivery could not be confirmed; no retry was attempted');
  }
}
