// Pair-aware static pruning. Unknown schemas and incomplete exchanges stay intact.
const keysOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const NOOP = /^(?:true|:|clear|sleep [0-9]+(?:\.[0-9]+)?[smhd]?)$/;
// No shell parsing: only literal cat paths, with no options or shell operators.
const READ_COMMAND = /^cat (?:[a-zA-Z0-9_./-]+)(?: [a-zA-Z0-9_./-]+)*$/;
const READ_TOOLS = new Set(['Read','Glob','Grep']);
const SHELL_TOOLS = new Set(['Bash','exec_command','shell_command']);
function pure(record, kind) {
  const entry = record.entry;
  if (entry.isCompactSummary || entry.isSidechain || entry.isMeta) return null;
  if (record.format === 'codex') {
    if (!keysOnly(entry,['type','timestamp','payload'])) return null;
    const p = entry.type === 'response_item' ? entry.payload : null;
    if (kind === 'call' && p?.type === 'function_call' && keysOnly(p,['type','id','call_id','name','arguments','internal_chat_message_metadata_passthrough'])) {
      try { const input = JSON.parse(p.arguments); return object(input) ? {name:p.name,input} : null; } catch { return null; }
    }
    if (kind === 'result' && p?.type === 'function_call_output' && keysOnly(p,['type','id','call_id','output','internal_chat_message_metadata_passthrough'])) return {output:p.output};
    return null;
  }
  if (!keysOnly(entry,['type','uuid','parentUuid','timestamp','sessionId','version','cwd','userType','isSidechain','isMeta','requestId','message','gitBranch'])) return null;
  if (!keysOnly(entry.message,['id','type','role','model','content','stop_reason','stop_sequence','usage']) || (entry.message.role != null && entry.message.role !== entry.type)) return null;
  const blocks = entry.message?.content;
  if (!Array.isArray(blocks) || blocks.length !== 1) return null;
  const p = blocks[0];
  if (kind === 'call' && entry.type === 'assistant' && p?.type === 'tool_use' && keysOnly(p,['type','id','name','input']) && object(p.input)) return {name:p.name,input:p.input};
  if (kind === 'result' && entry.type === 'user' && p?.type === 'tool_result' && keysOnly(p,['type','tool_use_id','content','is_error']) && p.is_error === false && typeof p.content === 'string') return {output:p.content, success:true};
  return null;
}
function shellOutput(output) {
  let value = output;
  if (typeof output === 'string') {
    try { value = JSON.parse(output); } catch {
      const match = /^(?:Chunk ID: [^\n]+\n)?Wall time: [0-9.]+ seconds\nProcess exited with code 0\n(?:Final output|Output):\n([\s\S]*)$/.exec(output);
      return match ? match[1] : null;
    }
  }
  if (!keysOnly(value,['output','exit_code','wall_time_seconds','chunk_id','session_id','original_token_count']) || value.exit_code !== 0 || value.session_id != null || typeof value.output !== 'string') return null;
  // Truncation means equality of visible output cannot prove equality of results.
  if (value.original_token_count != null) return null;
  return value.output;
}
function description(call, result) {
  if (SHELL_TOOLS.has(call.name)) {
    if (!keysOnly(call.input,['cmd','command','workdir','cwd','yield_time_ms','max_output_tokens','timeout','timeout_ms','description','login','shell','tty']) || call.input.tty === true) return null;
    const command = call.input.cmd ?? call.input.command;
    if (typeof command !== 'string' || (call.input.cmd != null && call.input.command != null)) return null;
    const output = result.success ? result.output : shellOutput(result.output);
    if (output == null || /truncat(?:ed|ion)/i.test(output)) return null;
    return {noop:NOOP.test(command) && output === '', read:READ_COMMAND.test(command) && !command.split(' ').slice(1).some(path => path.startsWith('-')), output};
  }
  const allowed = {Read:['file_path','offset','limit'],Glob:['pattern','path'],Grep:['pattern','path','glob','output_mode','-A','-B','-C','-n','-i','type','head_limit','multiline']};
  if (READ_TOOLS.has(call.name) && result.success && keysOnly(call.input,allowed[call.name])) return {read:true, output:result.output};
  return null;
}
export function pruneToolExchanges(records, keepTail = 0) {
  const calls = new Map(), results = new Map(), contexts = new Map();
  const positions = new Map(records.map((record,index) => [record,index]));
  let cwd = '';
  for (const record of records) {
    if (['session_meta','turn_context'].includes(record.entry.type)) cwd = record.entry.payload?.cwd ?? '';
    contexts.set(record, record.entry.cwd ?? cwd);
    for (const [ids,map] of [[record.issuedIds,calls],[record.answersIds,results]]) for (const id of ids ?? []) map.set(id,[...(map.get(id) ?? []),record]);
  }
  const previous = new Map();
  let turn;
  for (let position = 0; position < records.length; position++) {
    const record = records[position];
    if (turn !== record.turn) { previous.clear(); turn = record.turn; }
    if (!record.issuedIds?.length) continue;
    const id = record.issuedIds[0], resultRecords = results.get(id), call = pure(record,'call');
    const resultRecord = resultRecords?.[0], resultPosition = positions.get(resultRecord) ?? -1;
    const result = resultRecord && pure(resultRecord,'result');
    if (!call || record.issuedIds.length !== 1 || calls.get(id)?.length !== 1 || resultRecords?.length !== 1 || resultPosition <= position || resultRecord.turn !== record.turn || !result) { previous.clear(); continue; }
    const info = description(call,result);
    if (!info || (!info.noop && !info.read)) { previous.clear(); continue; }
    const pair = [record,resultRecord];
    // Generic Codex pins protect opaque tools; these pure schemas supply the
    // explicit provenance needed to remove both sides without weakening pins.
    const removable = position < records.length - keepTail && resultPosition < records.length - keepTail && pair.every(item => !item.removed && !item.tailProtected && item.category !== 'compact_summary');
    if (info.noop) {
      if (removable) pair.forEach(item => { item.removed = 'empty-noop-exchange'; });
      continue;
    }
    const context = call.input.workdir ?? call.input.cwd ?? contexts.get(record);
    if (typeof context !== 'string' || !context.startsWith('/')) { previous.clear(); continue; }
    const key = stable({turn:record.turn, name:call.name,input:call.input,cwd:context,output:info.output});
    const prior = previous.get(key);
    if (prior && prior.resultPosition < position && prior.removable) prior.pair.forEach(item => { item.removed = 'exact-read-repeat'; });
    previous.set(key,{pair,removable,resultPosition});
  }
}
