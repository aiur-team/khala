const isTool = (name, tool) => new RegExp(`(?:^|__)${tool}$`).test(name);
const contains = (value, marker) => {
  if (typeof value === 'string') {
    if (value.includes(marker)) return true;
    try { return contains(JSON.parse(value), marker); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(item => contains(item, marker));
  if (value && typeof value === 'object') return Object.values(value).some(item => contains(item, marker));
  return false;
};

export function modelEvidence(rows, harness, received, sent) {
  const calls = [];
  const results = [];
  rows.forEach((row, index) => {
    if (harness === 'codex') {
      const payload = row.type === 'response_item' && row.payload?.type === 'mcp_tool_call' ? row.payload : null;
      if (!payload) return;
      const name = String(payload.tool ?? payload.name ?? '');
      // Codex records the completed MCP call and its result in one rollout item.
      // An argument containing the challenge is never proof that read returned it.
      calls.push({ index, name, input: payload.arguments, result: payload.result });
      return;
    }
    if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const item of row.message.content) {
        if (item?.type === 'tool_use' && typeof item.id === 'string') {
          calls.push({ index, id: item.id, name: String(item.name ?? ''), input: item.input });
        }
      }
    }
    if (row.type === 'user' && Array.isArray(row.message?.content)) {
      for (const item of row.message.content) {
        if (item?.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          results.push({ index, id: item.tool_use_id, content: item.content, error: item.is_error === true });
        }
      }
    }
  });
  const reads = calls.filter(call => isTool(call.name, 'khala_read'));
  const successful = reads.flatMap(call => {
    if (harness === 'codex') {
      return contains(call.result, received) ? [{ index: call.index }] : [];
    }
    return results.filter(result => result.id === call.id && result.index > call.index && !result.error
      && contains(result.content, received));
  });
  const sendCall = successful.some(read => calls.some(call => call.index > read.index
    && isTool(call.name, 'khala_send') && contains(call.input, sent)));
  return { readCall: reads.length > 0, visible: successful.length > 0, sendCall };
}
