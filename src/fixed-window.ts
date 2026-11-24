import type { McpTool } from './types.js';

/**
 * Inspect the *declared* MCP JSON schema, not live monitoring data.
 * No result of this assessment grants an edit or verification PASS.
 */
export type WindowSchemaVerdict =
  'MISSING_TOOL' | 'NO_EXPLICIT_WINDOW' | 'INCOMPLETE_WINDOW' |
  'AMBIGUOUS_SCHEMA' | 'SCHEMA_CANDIDATE';

export interface WindowSchemaAssessment {
  toolName: 'whatap_query_data';
  verdict: WindowSchemaVerdict;
  declaredProperties: string[];
  requiredProperties: string[];
  declaredTypes: Record<string, string>;
  absoluteFieldPair: 'stime/etime' | null;
  requiresRelativeTimeRange: boolean;
  limitations: string[];
}

const rec=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function typename(v:unknown): string {
  if (!rec(v)) return 'unspecified';
  const t=v.type;
  return typeof t==='string' ? t : Array.isArray(t) && t.every(x=>typeof x==='string') ? t.join('|') : 'unspecified';
}
function numberTyped(v:unknown): boolean {
  if(!rec(v))return false;
  // Do not accept unknown, contradictory, union, coercible-string, or ref-only shapes.
  return v.type==='integer'||v.type==='number';
}

export function assessWindowSchema(tools: readonly McpTool[]):WindowSchemaAssessment {
  const named=tools.filter(x=>x.name==='whatap_query_data');
  const base:WindowSchemaAssessment={toolName:'whatap_query_data',verdict:'MISSING_TOOL',
    declaredProperties:[],requiredProperties:[],declaredTypes:{},absoluteFieldPair:null,
    requiresRelativeTimeRange:false,limitations:[
      '이 검사는 tools/list 메타데이터만 확인하며, 실제 조회 값/기간 일치나 서버의 인자 준수 여부를 증명하지 않습니다.',
      '스키마만으로는 동일 절대 기간 재현을 승인하거나 코드 수정을 허용할 수 없습니다.',
    ]};
  if(named.length===0){base.limitations.push('현재 whatap_query_data 도구가 목록에 없습니다.');return base;}
  if(named.length!==1){base.verdict='AMBIGUOUS_SCHEMA';base.limitations.push('동일 이름 도구가 중복 선언되었습니다.');return base;}
  const schema=named[0].inputSchema;
  if(!rec(schema)||!rec(schema.properties)){
    base.verdict='AMBIGUOUS_SCHEMA';base.limitations.push('도구 입력 스키마 properties 를 확인할 수 없습니다.');return base;
  }
  const props=schema.properties;
  base.declaredProperties=Object.keys(props).sort();
  base.requiredProperties=Array.isArray(schema.required) ? schema.required.filter(x=>typeof x==='string').sort() : [];
  base.declaredTypes=Object.fromEntries(base.declaredProperties.map(k=>[k,typename(props[k])]));
  base.requiresRelativeTimeRange=base.requiredProperties.includes('timeRange');
  const hasStart=Object.hasOwn(props,'stime'),hasEnd=Object.hasOwn(props,'etime');
  if(!hasStart&&!hasEnd){
    base.verdict='NO_EXPLICIT_WINDOW';base.limitations.push('stime/etime 명시적 시간 구간 인자가 스키마에 없습니다.');return base;
  }
  if(!hasStart||!hasEnd){
    base.verdict='INCOMPLETE_WINDOW';base.limitations.push('stime/etime 중 한 필드만 선언되어 있습니다.');return base;
  }
  if(!numberTyped(props.stime)||!numberTyped(props.etime)){
    base.verdict='AMBIGUOUS_SCHEMA';base.limitations.push('stime/etime 이 숫자형으로 명시되지 않았습니다.');return base;
  }
  if(base.requiresRelativeTimeRange){
    base.verdict='AMBIGUOUS_SCHEMA';base.limitations.push('절대 기간 필드가 있으나 timeRange 가 여전히 필수입니다. 상호 배제/우선순위를 별도로 검증해야 합니다.');return base;
  }
  // Even this is only a *candidate* for an executable replay contract.
  base.verdict='SCHEMA_CANDIDATE';base.absoluteFieldPair='stime/etime';
  base.limitations.push('명시적 시간 필드가 선언되어 있지만 서버가 이를 실제로 준수하는지는 별도의 통제된 재조회가 필요합니다.');
  return base;
}
