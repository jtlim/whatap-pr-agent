#!/usr/bin/env node
// Genuine LLM non-call must not be misclassified as a handshake error.
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'조회 도구를 호출하지 않았습니다.'}}));
console.log(JSON.stringify({type:'turn.completed'}));
