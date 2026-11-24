import test from 'node:test';
import assert from 'node:assert/strict';
import {nextAction} from '../tools/auto-campaign.mjs';
const state=(phase,status,extra={})=>({phase,status,...extra});
test('PASS ends with no extra calls',()=>assert.equal(nextAction(state('DONE','COMPLETED')).kind,'done'));
test('INITIAL_VERIFY auto resumes including durable retry',()=>{
  for(const x of ['READY','RUNNING','WAITING_RETRY'])assert.equal(nextAction(state('INITIAL_VERIFY',x)).kind,'resume');
});
test('Codex diagnosis only from explicit ANALYZING/PAUSED',()=>{
 assert.equal(nextAction(state('ANALYZING','PAUSED')).kind,'analyze');
 assert.equal(nextAction(state('ANALYZING','RUNNING')).kind,'stop');
 assert.equal(nextAction(state('ANALYZING','PAUSED',{lastError:'INTERRUPTED_CODEX_DIAGNOSIS'})).kind,'stop');
});
test('Pre-fix and final checks resume independently',()=>{
 assert.equal(nextAction(state('PRE_FIX_VERIFY','WAITING_RETRY')).kind,'precheck');
 assert.equal(nextAction(state('FINAL_VERIFY','READY')).kind,'finalcheck');
});
test('Code edit disabled by default, explicitly enabled in correct status only',()=>{
 assert.equal(nextAction(state('MODIFYING','PAUSED')).kind,'stop');
 assert.equal(nextAction(state('MODIFYING','PAUSED'),{allowEdit:true}).kind,'modify');
 assert.equal(nextAction(state('MODIFYING','RUNNING'),{allowEdit:true}).kind,'stop');
 assert.equal(nextAction(state('MODIFYING','PAUSED',{activeEditAttempt:{ordinal:1}}),{allowEdit:true}).kind,'stop');
});
test('Blocked never becomes PASS; can be archived only when explicitly requested',()=>{
 assert.equal(nextAction(state('PRE_FIX_VERIFY','BLOCKED')).kind,'stop');
 assert.equal(nextAction(state('PRE_FIX_VERIFY','BLOCKED'),{continueBlocked:true}).kind,'close');
 assert.equal(nextAction(state('PUSHING','BLOCKED'),{continueBlocked:true}).kind,'stop');
 assert.equal(nextAction(state('FINAL_VERIFY','BLOCKED'),{continueBlocked:true}).kind,'stop');
 assert.equal(nextAction(state('PRE_FIX_VERIFY','BLOCKED',{editHistory:[{ordinal:1}]}),{continueBlocked:true}).kind,'stop');
});
test('Submitted PR is a terminal campaign result; never merge or continue interrupted Git',()=>{
 assert.equal(nextAction(state('PR_OPEN','PR_OPEN'),{allowEdit:true,allowGit:true}).kind,'done');
 assert.equal(nextAction(state('PUSHING','RUNNING'),{allowEdit:true,allowGit:true}).kind,'stop');
 assert.equal(nextAction(state('CREATING_PR','BLOCKED'),{allowEdit:true,allowGit:true}).kind,'stop');
});
test('Git is opt-in, F2 backend gate remains authoritative',()=>{
 assert.equal(nextAction(state('COMMITTING','PAUSED')).kind,'stop');
 assert.equal(nextAction(state('COMMITTING','PAUSED'),{allowGit:true}).kind,'submit');
});
