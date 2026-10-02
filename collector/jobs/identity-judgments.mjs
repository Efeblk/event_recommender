import { canonical } from '../db/index.mjs';
import { decodeIdentityJudgment, IDENTITY_JEV_RUBRIC } from '../identity/jev.ts';

const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function validate(entry) {
  if(!entry||!digest(entry.key)||!digest(entry.inputHash)||entry.rubric!==IDENTITY_JEV_RUBRIC||
    !(entry.calibrationVersion===null||typeof entry.calibrationVersion==='string'&&entry.calibrationVersion.length>0&&entry.calibrationVersion.length<=200)||
    !/^jev-\d+\.\d+\.\d+$/.test(entry.judgment?.model??'')||!Array.isArray(entry.evidence)||entry.evidence.length!==2)
    throw new Error('Invalid durable identity judgment binding');
  const ids=new Set();
  for(const evidence of entry.evidence) {
    if(typeof evidence?.listingId!=='string'||!evidence.listingId||evidence.listingId.length>500||typeof evidence.url!=='string'||evidence.url.length>2048||!digest(evidence.evidenceHash)) throw new Error('Invalid durable identity evidence');
    const url=new URL(evidence.url);
    if(url.protocol!=='https:'||url.username||url.password) throw new Error('Invalid durable identity evidence URL');
    ids.add(evidence.listingId);
  }
  if(ids.size!==2) throw new Error('Identity judgments require two distinct listings');
  const judgment=decodeIdentityJudgment({model:entry.judgment.model,
    answers:{identity:{type:'choice',choice:entry.judgment.outcome,confidence:entry.judgment.confidence,probabilities:entry.judgment.probabilities}},
    usage:{input_tokens:entry.judgment.usage?.inputTokens,output_tokens:entry.judgment.usage?.outputTokens}},entry.judgment.model);
  if(entry.judgment.probability!==judgment.probability||judgment.usage.inputTokens>2147483647||judgment.usage.outputTokens>2147483647) throw new Error('Invalid durable identity judgment probability or usage');
  return {key:entry.key,inputHash:entry.inputHash,rubric:entry.rubric,calibrationVersion:entry.calibrationVersion,judgment,evidence:entry.evidence.map(e=>({listingId:e.listingId,url:e.url,evidenceHash:e.evidenceHash}))};
}

/** Immutable evidence-bound judgment cache, separate from actual merge decisions.
 * It makes no API calls, approves no merge, and supplies no call budget. */
export function createPostgresIdentityJudgmentCache(client) {
  const get=async key=>{
    if(!digest(key)) throw new Error('Invalid identity judgment cache key');
    const row=(await client.query('SELECT * FROM biplan_pipeline.identity_judgments WHERE cache_key=$1',[key])).rows[0];
    if(!row) return null;
    const probabilities={same_session:row.same_probability,different:row.different_probability,insufficient_evidence:row.insufficient_probability};
    return validate({key:row.cache_key,inputHash:row.input_hash,rubric:row.rubric_version,calibrationVersion:row.calibration_version,
      judgment:{outcome:row.outcome,probability:probabilities[row.outcome],confidence:row.confidence,probabilities,model:row.model_version,usage:{inputTokens:row.input_tokens,outputTokens:row.output_tokens}},evidence:row.evidence});
  };
  return {
    get,
    async put(value) {
      const entry=validate(value),judgment=entry.judgment;
      await client.query(`INSERT INTO biplan_pipeline.identity_judgments(cache_key,input_hash,rubric_version,model_version,calibration_version,
        outcome,same_probability,different_probability,insufficient_probability,confidence,input_tokens,output_tokens,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
      [entry.key,entry.inputHash,entry.rubric,judgment.model,entry.calibrationVersion,judgment.outcome,judgment.probabilities.same_session,judgment.probabilities.different,
        judgment.probabilities.insufficient_evidence,judgment.confidence,judgment.usage.inputTokens,judgment.usage.outputTokens,JSON.stringify(entry.evidence)]);
      if(canonical(await get(entry.key))!==canonical(entry)) throw new Error('Immutable identity judgment cache conflict');
    },
  };
}
