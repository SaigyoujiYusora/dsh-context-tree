// Cold list summaries may lack a projection checkpoint. Read the authoritative
// title events without acquiring an Agent or appending a replacement title.
export async function readSidebarTitles(ctx, payload) {
  if (!Array.isArray(payload?.ids) || payload.ids.length > 64
    || payload.ids.some(id => typeof id !== 'string' || id.length > 256)) {
    throw new Error('Invalid sidebar title request');
  }
  const listed = await ctx.sessionQuery.listSessions();
  const visible = new Set(listed.map(row => row.header?.id).filter(Boolean));
  const ids = [...new Set(payload.ids)].filter(id => visible.has(id));
  if (!ids.length) return { titles: {} };
  const results = await ctx.sessionQuery.readTitleSnapshots(ids);
  const titles = Object.create(null);
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { session, title } = result.value;
    if (!ids.includes(session?.id) || typeof title?.title !== 'string' || !title.title.trim()) continue;
    titles[session.id] = { title: title.title, createdAt: session.createdAt };
  }
  return { titles };
}
