#!/usr/bin/env node
// Codex-like event stream: the whatap MCP handshake failed before tools/call.
import { writeFileSync } from 'node:fs';
// An empty tap must not erase the Codex event diagnostics.
if(process.env.WHATAP_HARNESS_TAP_FILE) writeFileSync(process.env.WHATAP_HARNESS_TAP_FILE,'');
console.log(JSON.stringify({type:'item.completed',item:{
  id:'resource-probe',type:'mcp_tool_call',server:'whatap',tool:'list_mcp_resources',
  arguments:{},status:'failed',error:{message:'resources/list failed: failed to get client: MCP startup failed: handshaking with MCP server failed: connection closed: initialize response'}
}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'MCP 연결 초기화 실패'}}));
console.log(JSON.stringify({type:'turn.completed'}));
